const HATVault = artifacts.require("./HATVault.sol");
const HATVaultsRegistry = artifacts.require("./HATVaultsRegistry.sol");
const HATTokenMock = artifacts.require("./HATTokenMock.sol");
const ERC20Mock = artifacts.require("./ERC20Mock.sol");
const UniSwapV3RouterMock = artifacts.require("./UniSwapV3RouterMock.sol");
const TokenLockFactory = artifacts.require("./TokenLockFactory.sol");
const HATTokenLock = artifacts.require("./HATTokenLock.sol");
const RewardController = artifacts.require("./RewardController.sol");
const utils = require("./utils.js");

const { deployHatVaults } = require("../scripts/hatvaultsdeploy.js");

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
let epochRewardPerBlock = [
  web3.utils.toWei("441.3"),
  web3.utils.toWei("441.3"),
  web3.utils.toWei("882.5"),
  web3.utils.toWei("778.8"),
  web3.utils.toWei("687.3"),
  web3.utils.toWei("606.5"),
  web3.utils.toWei("535.3"),
  web3.utils.toWei("472.4"),
  web3.utils.toWei("416.9"),
  web3.utils.toWei("367.9"),
  web3.utils.toWei("324.7"),
  web3.utils.toWei("286.5"),
  web3.utils.toWei("252.8"),
  web3.utils.toWei("223.1"),
  web3.utils.toWei("196.9"),
  web3.utils.toWei("173.8"),
  web3.utils.toWei("153.4"),
  web3.utils.toWei("135.3"),
  web3.utils.toWei("119.4"),
  web3.utils.toWei("105.4"),
  web3.utils.toWei("93"),
  web3.utils.toWei("82.1"),
  web3.utils.toWei("72.4"),
  web3.utils.toWei("63.9"),
];

function assertVMException(error, expectedError = "") {
  let condition =
    error.message.search("VM Exception") > -1 ||
    error.message.search("Transaction reverted") > -1;
  assert.isTrue(
    condition,
    "Expected a VM Exception, got this instead:" + error.message
  );
  let expectedErrorMessage = "VM Exception while processing transaction: reverted with custom error '" +
      expectedError + "()'";
  let expectedReasonString = "VM Exception while processing transaction: reverted with reason string '" +
      expectedError + "'";
  if (expectedError) {
    assert(
      error.message === expectedErrorMessage ||
        error.message === expectedReasonString,
      "Expected error to be: " +
        expectedError +
        ", got this instead:" +
        error.message
    );
  }
}

const setup = async function(
  accounts,
  options = {}

) {
  const defaultOptions = {
    startBlock : (await web3.eth.getBlock("latest")).number,
    maxBounty : 8000,
    bountySplit : [7500, 2000, 500],
    hatBountySplit : [1500, 500],
    halvingAfterBlock : 10,
    routerReturnType : 0,
    allocPoint : 100,
    weth : false,
    rewardInVaults : 2500000,
    challengePeriod: 60 * 60 * 24,
    setDefaultArbitrator: true,
  };
  options = { ...defaultOptions, ...options};
  const committee = accounts[1];
  hatToken = await HATTokenMock.new(accounts[0]);
  stakingToken = await ERC20Mock.new("Staking", "STK");
  let wethAddress = utils.NULL_ADDRESS;
  if (options.weth) {
    wethAddress = stakingToken.address;
  }
  router = await UniSwapV3RouterMock.new(options.routerReturnType, wethAddress);
  var tokenLock = await HATTokenLock.new();
  tokenLockFactory = await TokenLockFactory.new(tokenLock.address);

  let deployment = await deployHatVaults(
    hatToken.address,
    options.startBlock,
    epochRewardPerBlock,
    options.halvingAfterBlock,
    accounts[0],
    hatToken.address,
    ...options.hatBountySplit,
    tokenLockFactory.address,
    true
  );

  hatVaultsRegistry = await HATVaultsRegistry.at(deployment.hatVaultsRegistry.address);
  rewardController = await RewardController.at(
    deployment.rewardController.address
  );

  await hatToken.setMinter(
    accounts[0],
    web3.utils.toWei((2500000 + options.rewardInVaults).toString())
  );
  await hatToken.mint(router.address, web3.utils.toWei("2500000"));
  if (options.rewardInVaults > 0) {
    await hatToken.mint(accounts[0], web3.utils.toWei(options.rewardInVaults.toString()));
    await hatToken.transfer(
      rewardController.address,
      web3.utils.toWei(options.rewardInVaults.toString())
   );
  }
  hatVaultsExpectedHatsBalance = options.rewardInVaults;

  // setting challengeClaim period to 0 will make running tests a bit easier
  let vault = await HATVault.at((await hatVaultsRegistry.createVault(
    stakingToken.address,
    await hatVaultsRegistry.owner(),
    accounts[1],
    rewardController.address,
    options.maxBounty,
    options.bountySplit,
    "_descriptionHash",
    86400,
    10,
    false
  )).logs[1].args._vault);

  if (options.challengePeriod) {
    await hatVaultsRegistry.setDefaultChallengePeriod(options.challengePeriod);
  }

  await rewardController.setAllocPoint(
    vault.address,
    options.allocPoint
  );
  await vault.committeeCheckIn({ from: committee });
  const registry = hatVaultsRegistry;
  let arbitrator;
  if (options.setDefaultArbitrator) {
    arbitrator = accounts[2];
    await registry.setDefaultArbitrator(arbitrator);

  }

  return {
    arbitrator,
    committee, // accounts[1]
    hatToken,
    owner: accounts[0],
    registry,
    rewardController,
    hatVaultsExpectedHatsBalance,
    router,
    someAccount: accounts[5], // an account without any special role
    stakingToken,
    vault,
    rewardControllerExpectedHatsBalance: options.rewardInVaults
  };
};

async function advanceToSafetyPeriod(hatVaultsRegistry) {
  let currentTimeStamp = (await web3.eth.getBlock("latest")).timestamp;

  let withdrawPeriod = (
    await hatVaultsRegistry.generalParameters()
  ).withdrawPeriod.toNumber();
  let safetyPeriod = (
    await hatVaultsRegistry.generalParameters()
  ).safetyPeriod.toNumber();

  if (currentTimeStamp % (withdrawPeriod + safetyPeriod) < withdrawPeriod) {
    await utils.increaseTime(
      withdrawPeriod - (currentTimeStamp % (withdrawPeriod + safetyPeriod))
    );
  }
}

//advanced time to a withdraw enable period
async function advanceToNonSafetyPeriod(hatVaultsRegistry) {
  let currentTimeStamp = (await web3.eth.getBlock("latest")).timestamp;
  let withdrawPeriod = (
    await hatVaultsRegistry.generalParameters()
  ).withdrawPeriod.toNumber();
  let safetyPeriod = (
    await hatVaultsRegistry.generalParameters()
  ).safetyPeriod.toNumber();
  if (currentTimeStamp % (withdrawPeriod + safetyPeriod) >= withdrawPeriod) {
    await utils.increaseTime(
      (currentTimeStamp % (withdrawPeriod + safetyPeriod)) +
        safetyPeriod -
        withdrawPeriod
    );
  }
}

async function submitClaim(vault, { accounts, bountyPercentage = 8000 }) {
  const tx = await vault.submitClaim(
    accounts[2],
    bountyPercentage,
    "description hash",
    {
      from: accounts[1],
    }
  );

  return tx.logs[0].args._claimId;
}

async function assertFunctionRaisesException(functionCall, exceptionString) {
  try {
    await functionCall;
    assert(false, "function call passed but was expected to fail");
  } catch (ex) {
    assertVMException(ex, exceptionString);
  }
}
module.exports = {
  setup,
  epochRewardPerBlock,
  assertVMException,
  advanceToSafetyPeriod,
  advanceToNonSafetyPeriod,
  submitClaim,
  assertFunctionRaisesException,
  ZERO_ADDRESS
};
