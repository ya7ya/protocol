const { toWei } = web3.utils;
const winston = require("winston");

const { interfaceName } = require("../../../core/utils/Constants.js");
const { MAX_UINT_VAL } = require("../../../common/Constants.js");

const { ExpiringMultiPartyClient } = require("../../clients/ExpiringMultiPartyClient");

const ExpiringMultiParty = artifacts.require("ExpiringMultiParty");
const Finder = artifacts.require("Finder");
const IdentifierWhitelist = artifacts.require("IdentifierWhitelist");
const MockOracle = artifacts.require("MockOracle");
const TokenFactory = artifacts.require("TokenFactory");
const Token = artifacts.require("ExpandedERC20");
const Timer = artifacts.require("Timer");

contract("ExpiringMultiPartyClient.js", function(accounts) {
  const sponsor1 = accounts[0];
  const sponsor2 = accounts[1];

  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const unreachableDeadline = MAX_UINT_VAL;

  let collateralToken;
  let emp;
  let client;
  let syntheticToken;
  let mockOracle;
  let identifierWhitelist;

  const updateAndVerify = async (client, expectedSponsors, expectedPositions) => {
    await client.update();

    assert.deepStrictEqual(expectedSponsors.sort(), client.getAllSponsors().sort());
    assert.deepStrictEqual(expectedPositions.sort(), client.getAllPositions().sort());
  };

  before(async function() {
    collateralToken = await Token.new("UMA", "UMA", 18, { from: sponsor1 });
    await collateralToken.addMember(1, sponsor1, { from: sponsor1 });
    await collateralToken.mint(sponsor1, toWei("100000"), { from: sponsor1 });
    await collateralToken.mint(sponsor2, toWei("100000"), { from: sponsor1 });

    identifierWhitelist = await IdentifierWhitelist.deployed();
    await identifierWhitelist.addSupportedIdentifier(web3.utils.utf8ToHex("UMATEST"));

    // Create a mockOracle and finder. Register the mockOracle with the finder.
    finder = await Finder.deployed();
    mockOracle = await MockOracle.new(finder.address, Timer.address);
    const mockOracleInterfaceName = web3.utils.utf8ToHex(interfaceName.Oracle);
    await finder.changeImplementationAddress(mockOracleInterfaceName, mockOracle.address);
  });

  beforeEach(async function() {
    const constructorParams = {
      expirationTimestamp: "12345678900",
      withdrawalLiveness: "1000",
      collateralAddress: collateralToken.address,
      finderAddress: Finder.address,
      tokenFactoryAddress: TokenFactory.address,
      priceFeedIdentifier: web3.utils.utf8ToHex("UMATEST"),
      syntheticName: "Test UMA Token",
      syntheticSymbol: "UMATEST",
      liquidationLiveness: "1000",
      collateralRequirement: { rawValue: toWei("1.5") },
      disputeBondPct: { rawValue: toWei("0.1") },
      sponsorDisputeRewardPct: { rawValue: toWei("0.1") },
      disputerDisputeRewardPct: { rawValue: toWei("0.1") },
      minSponsorTokens: { rawValue: toWei("1") },
      timerAddress: Timer.address
    };

    // The ExpiringMultiPartyClient does not emit any info `level` events.  Therefore no need to test Winston outputs.
    // DummyLogger will not print anything to console as only capture `info` level events.
    const dummyLogger = winston.createLogger({
      level: "info",
      transports: [new winston.transports.Console()]
    });

    emp = await ExpiringMultiParty.new(constructorParams);
    client = new ExpiringMultiPartyClient(dummyLogger, ExpiringMultiParty.abi, web3, emp.address);
    await collateralToken.approve(emp.address, toWei("1000000"), { from: sponsor1 });
    await collateralToken.approve(emp.address, toWei("1000000"), { from: sponsor2 });

    syntheticToken = await Token.at(await emp.tokenCurrency());
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: sponsor1 });
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: sponsor2 });
  });

  it("Returns all positions", async function() {
    // Create a position and check that it is detected correctly from the client.
    await emp.create({ rawValue: toWei("10") }, { rawValue: toWei("50") }, { from: sponsor1 });
    await updateAndVerify(
      client,
      [sponsor1], // expected sponsor
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("50"),
          amountCollateral: toWei("10"),
          hasPendingWithdrawal: false,
          withdrawalRequestPassTimestamp: "0",
          withdrawalRequestAmount: "0"
        }
      ] // expected position
    );

    // Calling create again from the same sponsor should add additional collateral & debt.
    await emp.create({ rawValue: toWei("10") }, { rawValue: toWei("50") }, { from: sponsor1 });
    await updateAndVerify(
      client,
      [sponsor1],
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("100"),
          amountCollateral: toWei("20"),
          hasPendingWithdrawal: false,
          withdrawalRequestPassTimestamp: "0",
          withdrawalRequestAmount: "0"
        }
      ]
    );

    // Calling create from a new address will create a new position and this should be added the the client.
    await emp.create({ rawValue: toWei("100") }, { rawValue: toWei("45") }, { from: sponsor2 });
    await updateAndVerify(
      client,
      [sponsor1, sponsor2],
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("100"),
          amountCollateral: toWei("20"),
          hasPendingWithdrawal: false,
          withdrawalRequestPassTimestamp: "0",
          withdrawalRequestAmount: "0"
        },
        {
          sponsor: sponsor2,
          numTokens: toWei("45"),
          amountCollateral: toWei("100"),
          hasPendingWithdrawal: false,
          withdrawalRequestPassTimestamp: "0",
          withdrawalRequestAmount: "0"
        }
      ]
    );

    // If a position is liquidated it should be removed from the list of positions and added to the undisputed liquidations.
    const { liquidationId } = await emp.createLiquidation.call(
      sponsor2,
      { rawValue: "0" },
      { rawValue: toWei("99999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: sponsor1 }
    );
    await emp.createLiquidation(
      sponsor2,
      { rawValue: "0" },
      { rawValue: toWei("99999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: sponsor1 }
    );

    await updateAndVerify(
      client,
      [sponsor1, sponsor2],
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("100"),
          amountCollateral: toWei("20"),
          hasPendingWithdrawal: false,
          withdrawalRequestPassTimestamp: "0",
          withdrawalRequestAmount: "0"
        }
      ]
    );
    const expectedLiquidations = [
      {
        sponsor: sponsor2,
        id: liquidationId.toString(),
        numTokens: toWei("45"),
        amountCollateral: toWei("100"),
        liquidationTime: (await emp.getCurrentTime()).toString(),
        liquidator: sponsor1,
        disputer: zeroAddress
      }
    ];
    assert.deepStrictEqual(expectedLiquidations.sort(), client.getUndisputedLiquidations().sort());

    // Pending withdrawals state should be correctly identified.
    await emp.requestWithdrawal({ rawValue: toWei("10") }, { from: sponsor1 });
    await client.update();

    await updateAndVerify(
      client,
      [sponsor1, sponsor2],
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("100"),
          amountCollateral: toWei("20"),
          hasPendingWithdrawal: true,
          withdrawalRequestPassTimestamp: (await emp.getCurrentTime()).add(await emp.withdrawalLiveness()).toString(),
          withdrawalRequestAmount: toWei("10")
        }
      ]
    );

    // Remove the pending withdrawal and ensure it is removed from the client.
    await emp.cancelWithdrawal({ from: sponsor1 });
    await client.update();
    // assert.deepStrictEqual([], client.getPendingWithdrawals());
  });

  it("Returns undercollateralized positions", async function() {
    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });
    await emp.create({ rawValue: toWei("1500") }, { rawValue: toWei("100") }, { from: sponsor2 });

    await client.update();
    // At 150% collateralization requirement, the position is just collateralized enough at a token price of 1.
    assert.deepStrictEqual([], client.getUnderCollateralizedPositions(toWei("1")));
    // Undercollateralized at a price just above 1.
    assert.deepStrictEqual(
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("100"),
          amountCollateral: toWei("150"),
          hasPendingWithdrawal: false,
          withdrawalRequestPassTimestamp: "0",
          withdrawalRequestAmount: "0"
        }
      ],
      client.getUnderCollateralizedPositions(toWei("1.00000000000000001"))
    );

    // After submitting a withdraw request that brings the position below the CR ratio the client should detect this.
    // Withdrawing just 1 wei of collateral will place the position below the CR ratio.
    await emp.requestWithdrawal({ rawValue: toWei("1") }, { from: sponsor1 });

    await client.update();
    // Update client to get withdrawal information.
    const currentTime = Number(await emp.getCurrentTime());
    assert.deepStrictEqual(
      [
        {
          sponsor: sponsor1,
          numTokens: toWei("100"),
          amountCollateral: toWei("150"),
          hasPendingWithdrawal: true,
          withdrawalRequestPassTimestamp: (currentTime + 1000).toString(),
          withdrawalRequestAmount: toWei("1")
        }
      ],
      client.getUnderCollateralizedPositions(toWei("1"))
    );
  });

  it("Returns undisputed liquidations", async function() {
    const liquidator = sponsor2;

    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });
    await syntheticToken.transfer(liquidator, toWei("100"), { from: sponsor1 });

    // Create a new liquidation for account[0]'s position.
    const { liquidationId } = await emp.createLiquidation.call(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("9999999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("9999999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await client.update();

    const liquidations = client.getUndisputedLiquidations();
    // Disputable if the disputer believes the price was `1`, and not disputable if they believe the price was just
    // above `1`.
    assert.isTrue(client.isDisputable(liquidations[0], toWei("1")));
    assert.isFalse(client.isDisputable(liquidations[0], toWei("1.00000000000000001")));

    // Dispute the liquidation and make sure it no longer shows up in the list.
    // We need to advance the Oracle time forward to make `requestPrice` work.
    await mockOracle.setCurrentTime(Number(await emp.getCurrentTime()) + 1);
    await emp.dispute(liquidationId.toString(), sponsor1, { from: sponsor1 });
    await client.update();

    // The disputed liquidation should no longer show up as undisputed.
    assert.deepStrictEqual([], client.getUndisputedLiquidations().sort());
  });

  it("Returns expired liquidations", async function() {
    const liquidator = sponsor2;

    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });
    await syntheticToken.transfer(liquidator, toWei("100"), { from: sponsor1 });

    // Create a new liquidation for account[0]'s position.
    await emp.createLiquidation.call(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("9999999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("9999999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await client.update();

    const liquidations = client.getUndisputedLiquidations();
    const liquidationTime = liquidations[0].liquidationTime;
    assert.deepStrictEqual(
      [
        {
          sponsor: sponsor1,
          id: "0",
          liquidationTime: liquidationTime,
          numTokens: toWei("100"),
          amountCollateral: toWei("150"),
          liquidator: liquidator,
          disputer: zeroAddress
        }
      ],
      liquidations
    );
    assert.deepStrictEqual([], client.getExpiredLiquidations().sort());

    // Move EMP time to the liquidation's expiry.
    const liquidationLiveness = 1000;
    await emp.setCurrentTime(Number(liquidationTime) + liquidationLiveness);
    await client.update();

    // The liquidation is registered by the EMP client as expired.
    assert.deepStrictEqual([], client.getUndisputedLiquidations().sort());
    const expiredLiquidations = client.getExpiredLiquidations();
    assert.deepStrictEqual(
      [
        {
          sponsor: sponsor1,
          id: "0",
          liquidationTime: liquidationTime,
          numTokens: toWei("100"),
          amountCollateral: toWei("150"),
          liquidator: liquidator,
          disputer: zeroAddress
        }
      ],
      expiredLiquidations
    );

    // Withdraw from the expired liquidation and check that the liquidation is deleted.
    await emp.withdrawLiquidation("0", sponsor1, { from: liquidator });
    await client.update();
    assert.deepStrictEqual([], client.getExpiredLiquidations().sort());
  });

  it("Returns disputed liquidations", async function() {
    const liquidator = sponsor2;

    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });
    await syntheticToken.transfer(liquidator, toWei("100"), { from: sponsor1 });

    // Create a new liquidation for account[0]'s position.
    const { liquidationId } = await emp.createLiquidation.call(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("9999999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("9999999") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await client.update();
    const liquidations = client.getUndisputedLiquidations();
    const liquidationTime = liquidations[0].liquidationTime;

    // There should be no disputed liquidations initially.
    assert.deepStrictEqual([], client.getDisputedLiquidations().sort());

    // Dispute the liquidation and make sure it no longer shows up in the list.
    // We need to advance the Oracle time forward to make `requestPrice` work.
    await mockOracle.setCurrentTime(Number(await emp.getCurrentTime()) + 1);
    await emp.dispute(liquidationId.toString(), sponsor1, { from: sponsor1 });
    await client.update();

    // The disputed liquidation should no longer show up as undisputed.
    assert.deepStrictEqual(
      [
        {
          sponsor: sponsor1,
          id: "0",
          liquidationTime: liquidationTime,
          numTokens: toWei("100"),
          amountCollateral: toWei("150"),
          liquidator: liquidator,
          disputer: sponsor1
        }
      ],
      client.getDisputedLiquidations().sort()
    );
    assert.deepStrictEqual([], client.getUndisputedLiquidations().sort());

    // Force a price such that the dispute fails, and then
    // withdraw from the unsuccessfully disputed liquidation and check that the liquidation is deleted.
    const disputePrice = toWei("1.6");
    await mockOracle.pushPrice(web3.utils.utf8ToHex("UMATEST"), liquidationTime, disputePrice);
    await emp.withdrawLiquidation("0", sponsor1, { from: liquidator });
    await client.update();
    assert.deepStrictEqual([], client.getDisputedLiquidations().sort());
  });
});
