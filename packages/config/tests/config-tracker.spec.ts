import { ChainIdLike, getChainId, sequenceContext } from "@0xsequence/network"
import { Account, AccountOptions, recoverConfig, recoverConfigFromDigest, Wallet, WalletConfigSource } from "@0xsequence/wallet"
import { BigNumber, ethers, Signer } from "ethers"
import { addressOf, ConfigTracker, DebugConfigTracker, decodeSignature, decodeSignaturePart, encodeSignature, imageHash, LocalConfigTracker, RedundantConfigTracker, SESSIONS_SPACE, staticRecoverConfig, staticRecoverConfigPart, WalletConfig } from "../src"
import { walletContracts } from "@0xsequence/abi"
import { Interface } from "ethers/lib/utils"
import { digestOfTransactions, digestOfTransactionsNonce, encodeNonce, packMetaTransactionsData, readSequenceNonce, SignedTransactionBundle, Transaction, unpackMetaTransactionData } from "@0xsequence/transactions"
import { subDigestOf } from "@0xsequence/utils"
import { PresignedConfigUpdate } from "../src/tracker/config-tracker"

import chaiAsPromised from 'chai-as-promised'
import * as chai from 'chai'

const { expect } = chai.use(chaiAsPromised)

describe('Config tracker', function () {
  const sessionNonce = encodeNonce(SESSIONS_SPACE, 0)
  const defaultChainId = 31337

  let configTracker: ConfigTracker
  let provider: ethers.providers.JsonRpcProvider
  let mainModuleInterface: Interface
  let mainModuleUpgradableInterface: Interface
  let sessionUtilsInterface: Interface
  let options: Omit<AccountOptions, 'address'>

  function randomConfigWithSigners(
    signers = Math.max(1, Math.floor(Math.random() * 50)),
    extras = Math.max(1, Math.floor(Math.random() * 50))
  ): {
    config: WalletConfig,
    signers: ethers.Wallet[]
  } {
    const s = new Array(signers).fill(0).map(() => ethers.Wallet.createRandom())
    const f = new Array(extras).fill(0).map(() => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20))))

    // Assign a random weight to each signer
    // in such a way that all of them are above the threshold
    const weights = s.map(() => ethers.BigNumber.from(Math.floor(Math.random() * 20)))
    const totalWeight = weights.reduce((acc, w) => acc.add(w), ethers.BigNumber.from(0))
    let threshold = totalWeight.mul(100).div(110)
    if (threshold.lt(1)) {
      threshold = ethers.BigNumber.from(1)
    } else if (threshold.gt(65534)) {
      threshold = ethers.BigNumber.from(65534)
    }

    const ss = s.map((s, i) => ({
      address: s.address,
      weight: weights[i].toNumber()
    }))

    const fs = f.map((f) => ({
      address: f,
      weight: ethers.BigNumber.from(Math.floor(Math.random() * 20)).toNumber()
    }))

    // Combine fs and ss and shuffle
    const signersAndExtras = fs.concat(ss)
    const shuffled = signersAndExtras.sort(() => 0.5 - Math.random())

    const config = {
      threshold: threshold.toNumber(),
      signers: shuffled,
    }

    return {
      config,
      signers: s
    }
  }

  function randomConfig(
    threshold?: number,
    signers?: number
  ): WalletConfig {
    const { config } = randomConfigWithSigners(0, signers)
    if (threshold) {
      config.threshold = threshold
    } else {
      config.threshold = config.signers.reduce((acc, s) => acc + s.weight, 0)
    }

    return config
  }

  function expectValidRoute(presigns: PresignedConfigUpdate[], args: {
    route: WalletConfig[],
    wallet: string,
    chainId: ethers.BigNumberish,
    update?: string
  }) {
    const { route, wallet, chainId, update } = args

    expect(presigns.length).to.equal(route.length - 1)

    for (let i = 0; i < presigns.length; i++) {
      const presign = presigns[i]
      const fromConfig = route[i]
      const newConfig = route[i + 1]
      expectValidSessionTx(presign, {
        fromConfig,
        newConfig,
        wallet,
        chainId,
        update: i === 0 ? update : undefined 
      })
    }
  }

  function expectValidSessionTx(presigned: PresignedConfigUpdate, args: {
    wallet: string,
    fromConfig: WalletConfig,
    newConfig: WalletConfig,
    chainId: ethers.BigNumberish,
    update?: string,
    timestamp?: number,
    margin?: number
  }) {
    const { wallet, fromConfig, newConfig, chainId, update } = args

    // Generic checks
    const newImageHash = imageHash(newConfig)
    expect(presigned.chainId.toString()).to.equal(chainId.toString())
    expect(presigned.signature).to.not.equal("")
    expect(presigned.body.wallet).to.equal(wallet)
    expect(presigned.body.newImageHash).to.deep.equal(newImageHash)
    expect(presigned.body.gapNonce.toNumber()).to.approximately(args.timestamp || Date.now(), args.margin || 5000)
    expect(presigned.body.tx).to.include(newImageHash.slice(2))
    expect(presigned.body.tx).to.include(sequenceContext.sessionUtils.toLowerCase().slice(2))
    expect(presigned.body.tx).to.include(presigned.body.gapNonce.toHexString().slice(2))
    expect(presigned.body.nonce).to.deep.equal(sessionNonce)

    // Decode tx data
    const unpacked = unpackMetaTransactionData(presigned.body.tx)

    // Signature verification
    // Recover config should match config
    const txDigest = digestOfTransactionsNonce(sessionNonce, ...unpacked)
    const subDigest = subDigestOf(wallet, chainId, txDigest)
    const decodedSignature = decodeSignature(presigned.signature)
    const { config: recoveredConfig } = staticRecoverConfig(subDigest, decodedSignature, 1)
    expect(recoveredConfig).to.deep.equal(fromConfig)

    // If update it should have 3 txs, otherwise just 2
    expect(unpacked.length).to.eq(update ? 3 : 2)

    // If update, then first transaction should be the update
    if (update) {
      expect(presigned.body.tx).to.include(update.toLowerCase().slice(2))
      expect(presigned.body.update).to.equal(update)

      expect(unpacked[0].to).to.equal(wallet)
      expect(unpacked[0].delegateCall).to.equal(false)
      expect(unpacked[0].revertOnError).to.equal(true)
      expect(unpacked[0].value.toString()).to.equal('0')
      expect(unpacked[0].gasLimit.toString()).to.equal('0')

      const expectedData = mainModuleInterface.encodeFunctionData(
        mainModuleInterface.getFunction('updateImplementation'), [update]
      )
  
      expect(unpacked[0].data).to.equal(expectedData)
    }

    // Penultimate transaction should be updateImageHash
    const i = unpacked.length - 2
    expect(unpacked[i].to).to.equal(wallet)
    expect(unpacked[i].delegateCall).to.equal(false)
    expect(unpacked[i].revertOnError).to.equal(true)
    expect(unpacked[i].value.toString()).to.equal('0')
    expect(unpacked[i].gasLimit.toString()).to.equal('0')

    const data = mainModuleUpgradableInterface.encodeFunctionData(
      mainModuleUpgradableInterface.getFunction('updateImageHash'), [newImageHash]
    )

    expect(unpacked[i].data).to.equal(data)

    // Last transaction should be requireSessionNonce
    const j = unpacked.length - 1
    expect(unpacked[j].to).to.equal(sequenceContext.sessionUtils)
    expect(unpacked[j].delegateCall).to.equal(true)
    expect(unpacked[j].revertOnError).to.equal(true)
    expect(unpacked[j].value.toString()).to.equal('0')
    expect(unpacked[j].gasLimit.toString()).to.equal('0')

    const data2 = sessionUtilsInterface.encodeFunctionData(
      sessionUtilsInterface.getFunction('requireSessionNonce'), [presigned.body.gapNonce]
    )
    expect(unpacked[j].data).to.equal(data2)
  }

  before(() => {
    configTracker = new LocalConfigTracker()
    mainModuleInterface = new Interface(walletContracts.mainModule.abi)
    mainModuleUpgradableInterface = new Interface(walletContracts.mainModuleUpgradable.abi)
    sessionUtilsInterface = new Interface(walletContracts.sessionUtils.abi)
    provider = new ethers.providers.JsonRpcProvider("http://localhost:7547")

    options = {
      configTracker,
      networks: [
        {
          name: 'local',
          chainId: 31337,
          provider
        }
      ]
    }
  })

  it("Should return undefined if config is not registered", async () => {
    const imageHash = "0xaf786307f2980ed0d0c78df4c2de3948907d5fefc008567a05d47a3dbb095f3b"
    const config = await configTracker.configOfImageHash({ imageHash })
    expect(config).to.be.undefined
  })

  it("Should save counter factual wallet", async () => {
    const config = randomConfig()
    const ih = imageHash(config)
    const context = sequenceContext

    await configTracker.saveCounterFactualWallet({ imageHash: ih, context })

    const wallet = addressOf(ih, context)
    const rih = await configTracker.imageHashOfCounterFactualWallet({ context, wallet })
    expect(rih).to.be.equal(ih)

    // Should return undefined for random context
    const badContext = { ...context, factory: ethers.Wallet.createRandom().address }
    const bres = await configTracker.imageHashOfCounterFactualWallet({ context: badContext, wallet })
    expect(bres).to.be.undefined

    // Should return undefined for random address
    const badWallet = ethers.Wallet.createRandom().address
    const bres2 = await configTracker.imageHashOfCounterFactualWallet({ context, wallet: badWallet })
    expect(bres2).to.be.undefined
  })

  it("Should save configurations", async () => {
    const config = randomConfig()
    configTracker.saveWalletConfig({ config: config })

    const resconfig = await configTracker.configOfImageHash({ imageHash: imageHash(config) })
    expect(resconfig).to.be.deep.equal(config)
  })

  it("Should save the same configuration twice", async () => {
    const config = randomConfig()

    configTracker.saveWalletConfig({ config })
    configTracker.saveWalletConfig({ config })

    const resconfig = await configTracker.configOfImageHash({ imageHash: imageHash(config) })
    expect(config).to.be.deep.equal(resconfig)
  })

  it("Should retrieve counter factual wallet address", async () => {
    const config = randomConfig()
    const ih = imageHash(config)
    const wallet = addressOf(ih, sequenceContext)

    await configTracker.saveCounterFactualWallet({ imageHash: ih, context: sequenceContext })

    const res = await configTracker.imageHashOfCounterFactualWallet({ wallet, context: sequenceContext })
    expect(res).to.be.equal(ih)
  })

  it("Should store presigned wallet update (with upgrade) in a single chain", async () => {
    const signer = ethers.Wallet.createRandom()

    const config = {
      threshold: 1,
      signers: [{
        address: signer.address,
        weight: 1
      }]
    }
    const fromImageHash = imageHash(config)

    const newConfig = randomConfig()

    const account = await Account.create(options, config, signer)
    await account.updateConfig(newConfig, defaultChainId)

    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash,
      chainId: defaultChainId,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(1)
    expectValidSessionTx(res1[0], {
      wallet: account.address,
      fromConfig: config,
      newConfig,
      chainId: defaultChainId,
      update: sequenceContext.mainModuleUpgradable
    })

    // Should return empty for other chains
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash,
      chainId: 2,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res2).to.deep.equal([])

    // Should return empty if no update is requested
    const res3 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash,
      chainId: defaultChainId,
      prependUpdate: []
    })
    expect(res3).to.deep.equal([])

    // Should return empty from invalid imageHash
    const res4 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      chainId: defaultChainId,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res4).to.deep.equal([])

    // Should return empty from invalid wallet
    const res5 = await configTracker.loadPresignedConfiguration({
      wallet: ethers.utils.hexlify(ethers.utils.randomBytes(20)),
      fromImageHash,
      chainId: defaultChainId,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res5).to.deep.equal([])
  })

  it("Should store presigned wallet update (with upgrade) in multiple chains", async () => {
    const signer = ethers.Wallet.createRandom()

    const config = {
      threshold: 1,
      signers: [{
        address: signer.address,
        weight: 1
      }]
    }
    const fromImageHash = imageHash(config)

    const newConfig = randomConfig()
    const newImageHash = imageHash(newConfig)

    const account = await Account.create(options, config, signer)
    await account.updateConfig(newConfig, defaultChainId, [2, 3, 4, 100])

    await Promise.all(([defaultChainId, 2, 3, 4, 100]).map(async (chainId) => {
      const res = await configTracker.loadPresignedConfiguration({
        wallet: account.address,
        fromImageHash,
        chainId: chainId,
        prependUpdate: [sequenceContext.mainModuleUpgradable]
      })
  
      expect(res.length).to.equal(1)
      expectValidSessionTx(res[0], {
        wallet: account.address,
        fromConfig: config,
        newConfig,
        chainId,
        update: sequenceContext.mainModuleUpgradable
      })
    }))

    // Should return empty for other chains
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash,
      chainId: 200,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res2).to.deep.equal([])

    // Should return empty if no update is requested
    const res3 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash,
      chainId: defaultChainId,
      prependUpdate: []
    })
    expect(res3).to.deep.equal([])

    // Should return empty from invalid imageHash
    const res4 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      chainId: defaultChainId,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res4).to.deep.equal([])

    // Should return empty from invalid wallet
    const res5 = await configTracker.loadPresignedConfiguration({
      wallet: ethers.utils.hexlify(ethers.utils.randomBytes(20)),
      fromImageHash,
      chainId: defaultChainId,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res5).to.deep.equal([])
  })

  it("Should construct presigned transaction with alternative config", async () => {
    const signer1 = ethers.Wallet.createRandom()
    const signer2 = ethers.Wallet.createRandom()
    const signer3 = ethers.Wallet.createRandom()

    const config = {
      threshold: 4,
      signers: [{
        address: signer1.address,
        weight: 2
      }, {
        address: signer2.address,
        weight: 2
      }, {
        address: signer3.address,
        weight: 2
      }]
    }

    const newConfig = randomConfig()
    const account = await Account.create(options, config, signer1, signer2)
    await account.updateConfig(newConfig, defaultChainId)

    // Generate alternative "from" config
    // but with enough signers anyway
    const altConfig = {
      threshold: 3,
      signers: [{
        address: signer1.address,
        weight: 2
      }, {
        address: signer2.address,
        weight: 1
      }, {
        address: signer3.address,
        weight: 1
      }, {
        address: ethers.Wallet.createRandom().address,
        weight: 100
      }]
    }

    // Store config, otherwise tracker can't route from it
    await configTracker.saveWalletConfig({ config: altConfig })

    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      fromImageHash: imageHash(altConfig),
      chainId: defaultChainId,
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(1)
    expectValidSessionTx(res1[0], {
      wallet: account.address,
      fromConfig: altConfig,
      newConfig,
      chainId: defaultChainId,
      update: sequenceContext.mainModuleUpgradable
    })
  })

  it("Should return wallets for signers (after update)", async () => {
    const signer1 = ethers.Wallet.createRandom()
    const signer2 = ethers.Wallet.createRandom()
    const signer3 = ethers.Wallet.createRandom()

    const config = {
      threshold: 4,
      signers: [{
        address: signer1.address,
        weight: 2
      }, {
        address: signer2.address,
        weight: 2
      }, {
        address: signer3.address,
        weight: 2
      }]
    }

    const newConfig2 = randomConfig()

    const account = await Account.create(options, config, signer1, signer2)
    await account.updateConfig(newConfig2, defaultChainId)

    const res1 = await configTracker.walletsOfSigner({ signer: signer1.address })
    expect(res1.length).to.equal(1)
    expect(res1[0].wallet).to.equal(account.address)
    expect(res1[0].proof.chainId.toNumber()).to.equal(defaultChainId)
  
    const subDigest1 = subDigestOf(res1[0].wallet, res1[0].proof.chainId, res1[0].proof.digest)
    const part1 = staticRecoverConfigPart(subDigest1, res1[0].proof.signature, res1[0].proof.chainId)
    expect(part1.signer).to.equal(signer1.address)

    const res2 = await configTracker.walletsOfSigner({ signer: signer2.address })
    expect(res2.length).to.equal(1)
    expect(res2[0].wallet).to.equal(account.address)
    expect(res2[0].proof.chainId.toNumber()).to.equal(defaultChainId)

    const subDigest2 = subDigestOf(res2[0].wallet, res2[0].proof.chainId, res2[0].proof.digest)
    const part2 = staticRecoverConfigPart(subDigest2, res2[0].proof.signature, res2[0].proof.chainId)
    expect(part2.signer).to.equal(signer2.address)

    const res3 = await configTracker.walletsOfSigner({ signer: signer3.address })
    // Should be empty for signer3 because is not signing
    expect(res3.length).to.equal(0)

    // 2 subdigests should be equal
    expect(subDigest1).to.equal(subDigest2)
  })

  it("Should return wallets for signers (without update, just witness)", async () => {
    const signer1 = ethers.Wallet.createRandom()
    const signer2 = ethers.Wallet.createRandom()
    const signer3 = ethers.Wallet.createRandom()

    const config = {
      threshold: 4,
      signers: [{
        address: signer1.address,
        weight: 2
      }, {
        address: signer2.address,
        weight: 2
      }, {
        address: signer3.address,
        weight: 2
      }]
    }

    const account = await Account.create(options, config, signer1, signer2)
    const witnessMessage = `0xSequence witness: ${ethers.utils.hexlify(ethers.utils.randomBytes(32))}`
    const witnessDigest = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(witnessMessage))
    const signed = await account.signMessage(witnessDigest, defaultChainId, undefined, true)
    await configTracker.saveWitness({ wallet: account.address, digest: witnessDigest, signatures: [{ signature: signed, chainId: defaultChainId }] })

    const res1 = await configTracker.walletsOfSigner({ signer: signer1.address })
    expect(res1.length).to.equal(1)
    expect(res1[0].wallet).to.equal(account.address)
    expect(res1[0].proof.chainId.toNumber()).to.equal(defaultChainId)
  
    const subDigest1 = subDigestOf(res1[0].wallet, res1[0].proof.chainId, res1[0].proof.digest)
    const part1 = staticRecoverConfigPart(subDigest1, res1[0].proof.signature, res1[0].proof.chainId)
    expect(part1.signer).to.equal(signer1.address)

    const res2 = await configTracker.walletsOfSigner({ signer: signer2.address })
    expect(res2.length).to.equal(1)
    expect(res2[0].wallet).to.equal(account.address)
    expect(res2[0].proof.chainId.toNumber()).to.equal(defaultChainId)

    const subDigest2 = subDigestOf(res2[0].wallet, res2[0].proof.chainId, res2[0].proof.digest)
    const part2 = staticRecoverConfigPart(subDigest2, res2[0].proof.signature, res2[0].proof.chainId)
    expect(part2.signer).to.equal(signer2.address)

    const res3 = await configTracker.walletsOfSigner({ signer: signer3.address })
    // Should be empty for signer3 because is not signing
    expect(res3.length).to.equal(0)

    // 2 subdigests should be equal
    expect(subDigest1).to.equal(subDigest2)
  })

  it("Should return presigned wallet update with 2 jumps", async () => {
    const signer1 = ethers.Wallet.createRandom()
    const signer2 = ethers.Wallet.createRandom()
    const signer3 = ethers.Wallet.createRandom()

    const config = {
      threshold: 4,
      signers: [{
        address: signer1.address,
        weight: 2
      }, {
        address: signer2.address,
        weight: 2
      }, {
        address: signer3.address,
        weight: 2
      }]
    }

    const signer4 = ethers.Wallet.createRandom()
    const signer5 = ethers.Wallet.createRandom()
    const signer6 = ethers.Wallet.createRandom()
    const signer7 = ethers.Wallet.createRandom()

    const config2 = {
      threshold: 5,
      signers: [{
        address: signer4.address,
        weight: 2
      }, {
        address: signer5.address,
        weight: 1
      }, {
        address: signer6.address,
        weight: 9
      }, {
        address: signer7.address,
        weight: 2
      }]
    }

    const config3 = randomConfig()

    const account = await Account.create(options, config, signer1, signer3)
    await account.updateConfig(config2, defaultChainId)
    await account.useSigners(signer4, signer5, signer7).updateConfig(config3, defaultChainId)

    const res = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(config),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res.length).to.equal(2)
    expectValidSessionTx(res[0], {
      wallet: account.address,
      fromConfig: config,
      newConfig: config2,
      chainId: defaultChainId,
      update: sequenceContext.mainModuleUpgradable
    })

    expectValidSessionTx(res[1], {
      wallet: account.address,
      fromConfig: config2,
      newConfig: config3,
      chainId: defaultChainId
    })

    // Should return a single jump going from config2 to config3
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(config2),
      prependUpdate: []
    })

    expect(res2.length).to.equal(1)
    expectValidSessionTx(res2[0], {
      wallet: account.address,
      fromConfig: config2,
      newConfig: config3,
      chainId: defaultChainId
    })
  })

  it("Should handle presigned route with two alternative paths", async () => {
    // Config A --> Config B -> Config C -> Config D
    //          \                       /
    //           -> Config E -----------

    const { config: configA, signers: signersA } = randomConfigWithSigners(3, 5)
    const { config: configB, signers: signersB } = randomConfigWithSigners(2, 1)
    const { config: configC, signers: signersC } = randomConfigWithSigners(7, 0)
    const { config: configE, signers: signersE } = randomConfigWithSigners(5, 10)
    const { config: configD } = randomConfigWithSigners(5, 10)

    const account = await Account.create(options, configA, ...signersA)
    await account.updateConfig(configB, defaultChainId)
    await account.useSigners(...signersB).updateConfig(configC, defaultChainId)
    await account.useSigners(...signersC).updateConfig(configD, defaultChainId)

    const timestamp = Date.now()
    const margin = 10000

    // Use a different config tracker, force the fork
    const tmpConfigTracker = new LocalConfigTracker()
    const account2 = await Account.create({ ...options, configTracker: tmpConfigTracker }, configA, ...signersA)
    await account2.updateConfig(configE, defaultChainId)
    await account2.useSigners(...signersE).updateConfig(configD, defaultChainId)

    // Send alternative presigned configuration to main configTracker
    const pre = await tmpConfigTracker.loadPresignedConfiguration({
      wallet: account2.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(pre.length).to.equal(2)

    await configTracker.savePresignedConfiguration({
      wallet: account2.address,
      config: configE,
      tx: pre[0].body,
      signatures: [{
        chainId: ethers.BigNumber.from(defaultChainId),
        signature: pre[0].signature
      }]
    })

    await configTracker.savePresignedConfiguration({
      wallet: account2.address,
      config: configD,
      tx: pre[1].body,
      signatures: [{
        chainId: ethers.BigNumber.from(defaultChainId),
        signature: pre[1].signature
      }]
    })

    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(2)
    expectValidSessionTx(res1[0], {
      wallet: account.address,
      fromConfig: configA,
      newConfig: configE,
      chainId: defaultChainId,
      update: sequenceContext.mainModuleUpgradable,
      timestamp,
      margin
    })
    expectValidSessionTx(res1[1], {
      wallet: account.address,
      fromConfig: configE,
      newConfig: configD,
      chainId: defaultChainId,
      timestamp,
      margin
    })

    // From config B is B -> C -> D (without update)
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configB),
      prependUpdate: []
    })

    expect(res2.length).to.equal(2)
    expectValidSessionTx(res2[0], {
      wallet: account.address,
      fromConfig: configB,
      newConfig: configC,
      chainId: defaultChainId,
      timestamp,
      margin
    })
    expectValidSessionTx(res2[1], {
      wallet: account.address,
      fromConfig: configC,
      newConfig: configD,
      chainId: defaultChainId,
      timestamp,
      margin
    })

    // From config E is E -> D (without update)
    const res3 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configE),
      prependUpdate: []
    })

    expect(res3.length).to.equal(1)
    expectValidSessionTx(res3[0], {
      wallet: account.address,
      fromConfig: configE,
      newConfig: configD,
      chainId: defaultChainId,
      timestamp,
      margin
    })

    // From config C is C -> D (without update)
    const res4 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configC),
      prependUpdate: []
    })

    expect(res4.length).to.equal(1)
    expectValidSessionTx(res4[0], {
      wallet: account.address,
      fromConfig: configC,
      newConfig: configD,
      chainId: defaultChainId,
      timestamp,
      margin
    })

    // From config D there is no update
    const res5 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configD),
      prependUpdate: []
    })

    expect(res5.length).to.equal(0)
  })

  it("Should handle circular route", async () => {
    //    -> Wallet A -> Wallet B --
    //  /                            \
    //  \                            /
    //    -- Wallet D <- Wallet C <-
    //

    const { config: configA, signers: signersA } = randomConfigWithSigners(3, 5)
    const { config: configB, signers: signersB } = randomConfigWithSigners(2, 1)
    const { config: configC, signers: signersC } = randomConfigWithSigners(7, 0)
    const { config: configD, signers: signersD } = randomConfigWithSigners(5, 10)

    const account = await Account.create(options, configA, ...signersA)
    await account.updateConfig(configB, defaultChainId)
    await account.useSigners(...signersB).updateConfig(configC, defaultChainId)
    await account.useSigners(...signersC).updateConfig(configD, defaultChainId)
    await account.useSigners(...signersD).updateConfig(configA, defaultChainId)

    // Route from A should lead to A but with 4 jumps
    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(4)
    expectValidRoute(res1, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configB, configC, configD, configA],
      update: sequenceContext.mainModuleUpgradable,
    })

    // Route from B should lead to A with 3 jumps
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configB),
      prependUpdate: []
    })

    expect(res2.length).to.equal(3)
    expectValidRoute(res2, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configB, configC, configD, configA],
    })
  })

  it("Should handle circular route (with fork)", async () => {
    //  Wallet A --> Wallet A --> Wallet B --> Wallet C --> Wallet D --> Wallet A --> Wallet E
    //

    const { config: configA, signers: signersA } = randomConfigWithSigners(3, 5)
    const { config: configB, signers: signersB } = randomConfigWithSigners(2, 1)
    const { config: configC, signers: signersC } = randomConfigWithSigners(7, 0)
    const { config: configD, signers: signersD } = randomConfigWithSigners(5, 10)
    const { config: configE, signers: signersE } = randomConfigWithSigners(3, 15)

    const account = await Account.create(options, configA, ...signersA)
    // Update from A to A just to upgrade the wallet implementation
    await account.updateConfig(configA, defaultChainId)
    await account.useSigners(...signersA).updateConfig(configB, defaultChainId)
    await account.useSigners(...signersB).updateConfig(configC, defaultChainId)
    await account.useSigners(...signersC).updateConfig(configD, defaultChainId)
    await account.useSigners(...signersD).updateConfig(configA, defaultChainId)
    await account.useSigners(...signersA).updateConfig(configE, defaultChainId)

    // Route from A should lead to E but with just 1 jump
    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(2)
    expectValidRoute(res1, {
      wallet: account.address,
      chainId: defaultChainId,
      // Two config A updates, first one is just an imp change
      route: [configA, configA, configE],
      update: sequenceContext.mainModuleUpgradable,
    })

    // Route from B should lead to E with 4 jumps
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configB),
      prependUpdate: []
    })

    expect(res2.length).to.equal(4)
    expectValidRoute(res2, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configB, configC, configD, configA, configE],
    })

    // Route from A (without update) should just be A -> E
    const res3 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: []
    })

    expect(res3.length).to.equal(1)
    expectValidRoute(res3, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configE],
    })
  })

  it("Should handle complex routes", async () => {
    // Wallet A --> Wallet B ---> Wallet C -> Wallet H
    //          \             /
    //           -> Wallet E /
    //                       \
    //                        --> Wallet F -> Wallet G
    // Wallet D

    const { config: configA, signers: signersA } = randomConfigWithSigners(3, 5)
    const { config: configB, signers: signersB } = randomConfigWithSigners(2, 1)
    const { config: configC, signers: signersC } = randomConfigWithSigners(7, 0)
    const { config: configD } = randomConfigWithSigners(5, 10)
    const { config: configE, signers: signersE } = randomConfigWithSigners(3, 15)
    const { config: configF, signers: signersF } = randomConfigWithSigners(2, 20)
    const { config: configG } = randomConfigWithSigners(4, 25)
    const { config: configH } = randomConfigWithSigners(6, 22)

    await configTracker.saveWalletConfig({ config: configD })

    const account = await Account.create(options, configA, ...signersA)
    await account.updateConfig(configB, defaultChainId)
    await account.useSigners(...signersB).updateConfig(configC, defaultChainId)

    const tmpConfigTrackerA = new LocalConfigTracker()
    const tmpConfigTrackerB = new LocalConfigTracker()
    const tmpConfigTrackerAB = new RedundantConfigTracker([tmpConfigTrackerA, tmpConfigTrackerB])

    const accountAB = await Account.create({ ...options, configTracker: tmpConfigTrackerAB }, configA, ...signersA)
    await accountAB.updateConfig(configE, defaultChainId)

    const accountB = new Account({ ...options, address: account.address, configTracker: tmpConfigTrackerB }, ...signersE)
    await accountB.updateConfig(configC, defaultChainId)

    const accountA = new Account({ ...options, address: account.address, configTracker: tmpConfigTrackerA }, ...signersE)
    await accountA.updateConfig(configF, defaultChainId)
    await accountA.useSigners(...signersF).updateConfig(configG, defaultChainId)

    await account.useSigners(...signersC).updateConfig(configH, defaultChainId)

    // Feed routes from tmp trackers to main tracker
    const feed1 = await tmpConfigTrackerA.loadPresignedConfiguration({
      wallet: accountA.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(feed1.length).to.equal(3)
    expectValidRoute(feed1, {
      wallet: accountA.address,
      chainId: defaultChainId,
      route: [configA, configE, configF, configG],
      update: sequenceContext.mainModuleUpgradable,
    })

    const feed2 = await tmpConfigTrackerB.loadPresignedConfiguration({
      wallet: accountB.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(feed2.length).to.equal(2)
    expectValidRoute(feed2, {
      wallet: accountB.address,
      chainId: defaultChainId,
      route: [configA, configE, configC],
      update: sequenceContext.mainModuleUpgradable 
    })

    for (const jump of [...feed1, ...feed2]) {
      const config = await tmpConfigTrackerAB.configOfImageHash({ imageHash: jump.body.newImageHash })
      await configTracker.savePresignedConfiguration({
        wallet: account.address,
        config,
        tx: jump.body,
        signatures: [{
          chainId: ethers.BigNumber.from(defaultChainId),
          signature: jump.signature
        }]
      })
    }

    // Route from A should lead to H
    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(3)
    expectValidRoute(res1, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configB, configC, configH],
      update: sequenceContext.mainModuleUpgradable,
    })

    // Route from B should lead to H
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configB),
      prependUpdate: []
    })
    expectValidRoute(res2, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configB, configC, configH]
    })

    // Route from E should lead to H
    const res3 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configE),
      prependUpdate: []
    })
    expectValidRoute(res3, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configE, configC, configH]
    })

    // Route from F should lead to G
    const res4 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configF),
      prependUpdate: []
    })
    expectValidRoute(res4, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configF, configG]
    })

    // Route from D should lead nowhere
    const res5 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configD),
      prependUpdate: []
    })
    expect(res5.length).to.equal(0)
    const res6 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configD),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res6.length).to.equal(0)
  })

  it("Should find highest gap nonce when shortest path", async () => {
    // Wallet A --> Wallet C --> Wallet D --> Wallet E
    //          \
    //           -> Wallet B

    const { config: configA, signers: signersA } = randomConfigWithSigners(7, 0)
    const { config: configB, signers: signersB } = randomConfigWithSigners(5, 10)
    const { config: configC, signers: signersC } = randomConfigWithSigners(3, 15)
    const { config: configD, signers: signersD } = randomConfigWithSigners(1, 20)
    const { config: configE, signers: signersE } = randomConfigWithSigners(0, 25)

    const account = await Account.create(options, configA, ...signersA)
    await account.updateConfig(configC, defaultChainId)
    await account.useSigners(...signersC).updateConfig(configD, defaultChainId)
    await account.useSigners(...signersD).updateConfig(configE, defaultChainId)

    // Returns long path, A -> B doesn't exist
    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(res1.length).to.equal(3)
    expectValidRoute(res1, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configC, configD, configE],
      update: sequenceContext.mainModuleUpgradable,
    })

    const tmpConfigTracker = new LocalConfigTracker()
    const tmpAccount = await Account.create({ ...options, configTracker: tmpConfigTracker }, configA, ...signersA)
    await tmpAccount.updateConfig(configB, defaultChainId)

    const feed = await tmpConfigTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })

    expect(feed.length).to.equal(1)
    expectValidRoute(feed, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configB],
      update: sequenceContext.mainModuleUpgradable,
    })

    for (const jump of feed) {
      await configTracker.savePresignedConfiguration({
        wallet: account.address,
        config: configB,
        tx: jump.body,
        signatures: [{
          chainId: ethers.BigNumber.from(defaultChainId),
          signature: jump.signature
        }]
      })
    }

    // Now the highest gapNonce path is just A -> B
    const res2 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res2.length).to.equal(1)
    expectValidRoute(res2, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configB],
      update: sequenceContext.mainModuleUpgradable,
    })
  })

  it("Should find highest gap nonce when longest path", async () => {
    // Wallet A --> Wallet C --> Wallet D --> Wallet E
    //          \
    //           -> Wallet B

    const { config: configA, signers: signersA } = randomConfigWithSigners(7, 0)
    const { config: configB, signers: signersB } = randomConfigWithSigners(5, 10)
    const { config: configC, signers: signersC } = randomConfigWithSigners(3, 15)
    const { config: configD, signers: signersD } = randomConfigWithSigners(1, 20)
    const { config: configE, signers: signersE } = randomConfigWithSigners(0, 25)

    const tmpConfigTracker = new LocalConfigTracker()
    const tmpAccount = await Account.create({ ...options, configTracker: tmpConfigTracker }, configA, ...signersA)
    await tmpAccount.updateConfig(configB, defaultChainId)

    const account = await Account.create(options, configA, ...signersA)
    await account.updateConfig(configC, defaultChainId)
    await account.useSigners(...signersC).updateConfig(configD, defaultChainId)
    await account.useSigners(...signersD).updateConfig(configE, defaultChainId)

    // Feed tmp to configTracker
    const feed = await tmpConfigTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    for (const jump of feed) {
      await configTracker.savePresignedConfiguration({
        wallet: account.address,
        config: configB,
        tx: jump.body,
        signatures: [{
          chainId: ethers.BigNumber.from(defaultChainId),
          signature: jump.signature
        }]
      })
    }

    // Now the highest gapNonce path is still A -> C -> D -> E
    const res1 = await configTracker.loadPresignedConfiguration({
      wallet: account.address,
      chainId: defaultChainId,
      fromImageHash: imageHash(configA),
      prependUpdate: [sequenceContext.mainModuleUpgradable]
    })
    expect(res1.length).to.equal(3)
    expectValidRoute(res1, {
      wallet: account.address,
      chainId: defaultChainId,
      route: [configA, configC, configD, configE],
      update: sequenceContext.mainModuleUpgradable,
    })
  })

  describe("Bad presigned transactions", () => {
    const defaultGapNonce = ethers.BigNumber.from(10000)

    let wallet: Wallet
    let signers: Signer[]

    let configA: WalletConfig
    let configB: WalletConfig

    before(async () => {
      const { config: _configA, signers: signersA } = randomConfigWithSigners(7, 4)
      const { config: _configB, signers: signersB } = randomConfigWithSigners(5, 10)

      configA = _configA
      configB = _configB

      wallet = new Wallet({ config: configA }, ...signersA).setProvider(provider)
      signers = signersA
    })

    const buildUpdateConfig = async (args?: {
      newConfig?: WalletConfig,
      chainId?: ChainIdLike,
      gapNonce?: ethers.BigNumber,
      appendUpdate?: boolean,
      nonce?: ethers.BigNumber,
    }): Promise<Transaction[]> => {
      const { newConfig, chainId, gapNonce, nonce, appendUpdate } = args || {}

      const sessionUtilsInterface = new Interface(walletContracts.sessionUtils.abi)
      const sessionNonce = encodeNonce(SESSIONS_SPACE, 0)
  
      const newImageHash = imageHash(newConfig || configB)
      const updateBundle = await wallet.buildUpdateConfig(newImageHash, chainId || defaultChainId, !appendUpdate)
  
      const transactions: Transaction[] = [...updateBundle.transactions]
  
      // Append session utils requireGapNonce (session nonce)
  
      transactions.push({
        delegateCall: true,
        revertOnError: true,
        gasLimit: ethers.constants.Zero,
        to: sequenceContext.sessionUtils,
        value: ethers.constants.Zero,
        data: sessionUtilsInterface.encodeFunctionData(sessionUtilsInterface.getFunction('requireSessionNonce'), [gapNonce || defaultGapNonce])
      })
  
      return transactions.map((t) => ({ ...t, nonce: nonce || sessionNonce }))
    }

    const buildSavePresignedConf = (args: {
      address?: string,
      config?: WalletConfig,
      txs: Transaction[],
      nonce?: ethers.BigNumber,
      gapNonce?: ethers.BigNumber,
      signature: SignedTransactionBundle,
      chainId?: ethers.BigNumber
    }) => {
      const { address, config, txs, gapNonce, signature, chainId, nonce } = args

      return {
        wallet: address || wallet.address,
        config: config || configB,
        tx: {
          wallet: address || wallet.address,
          tx: packMetaTransactionsData(txs),
          newImageHash: imageHash(config || configB),
          nonce: nonce || signature.nonce,
          gapNonce: gapNonce || defaultGapNonce
        },
        signatures: [{
          chainId: chainId || ethers.BigNumber.from(defaultChainId),
          signature: encodeSignature(signature.signature)
        }]
      }
    }

    it("Should reject txs with bad nonce (on payload)", async () => {
      const badtxs = await buildUpdateConfig()

      const signature = await wallet.signTransactions(badtxs, defaultChainId)
      const res = configTracker.savePresignedConfiguration(
        buildSavePresignedConf({
          txs: badtxs,
          signature,
          nonce: ethers.BigNumber.from(900)
        })
      )

      await expect(res).to.be.rejected
    })

    it("Should reject txs with bad nonce (on both payload and body)", async () => {
      const badtxs = await buildUpdateConfig({ nonce: ethers.BigNumber.from(900) })

      const signature = await wallet.signTransactions(badtxs, defaultChainId)
      const res = configTracker.savePresignedConfiguration(
        buildSavePresignedConf({
          txs: badtxs,
          signature,
          nonce: ethers.BigNumber.from(900)
        })
      )

      await expect(res).to.be.rejected
    })

    it("Should reject bundle with a single transaction", async () => {
      const txs = await buildUpdateConfig()
      const badtxs = [txs[0]]

      const signature = await wallet.signTransactions(badtxs, defaultChainId)
      const res = configTracker.savePresignedConfiguration(
        buildSavePresignedConf({
          txs: badtxs,
          signature
        })
      )

      await expect(res).to.be.rejected
    })

    it("Should reject bundle with extra txs", async () => {
      const txs = await buildUpdateConfig()
      const badtxs = [...txs, txs[0]]

      const signature = await wallet.signTransactions(badtxs, defaultChainId)
      const res = configTracker.savePresignedConfiguration(
        buildSavePresignedConf({
          txs: badtxs,
          signature
        })
      )

      await expect(res).to.be.rejected
    })

    it("Should reject bundle with wrong config on payload", async () => {
      const txs = await buildUpdateConfig()

      const signature = await wallet.signTransactions(txs, defaultChainId)
      const res = configTracker.savePresignedConfiguration(
        buildSavePresignedConf({
          txs,
          signature,
          config: configA
        })
      )

      await expect(res).to.be.rejected
    })

    context("Out of order txs", () => {
      ([
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ]).map((order) => {
        it("Should reject bundle with update and out of order txs: [" + order.join(", ") + "]", async () => {
          const txs = await buildUpdateConfig({ appendUpdate: true })
          const badtxs = [txs[order[0]], txs[order[1]], txs[order[2]]]

          const signature = await wallet.signTransactions(badtxs, defaultChainId)
          const res = configTracker.savePresignedConfiguration(
            buildSavePresignedConf({
              txs: badtxs,
              signature
            })
          )

          await expect(res).to.be.rejected
        })
      })

      it("Should reject bundle without update and out of order txs: [1, 0]", async () => {
        const txs = await buildUpdateConfig({ appendUpdate: false })
        const badtxs = [txs[1], txs[0]]

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      })
    })

    context("Bad 'delegateCall'", () => {
      ([
        { update: true,  index: 0, expected: false },
        { update: true,  index: 1, expected: false },
        { update: true,  index: 2, expected: true  },
        { update: false, index: 0, expected: false },
        { update: false, index: 1, expected: true  },
      ]).map((o) => it(`${o.update ? "With" : "Without"} update on tx[${o.index}], should be delegateCall: ${o.expected}`, async () => {
        const badtxs = await buildUpdateConfig({ appendUpdate: o.update })
        badtxs[o.index].delegateCall = !o.expected

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      }))
    })

    context("Bad 'revertOnError'", () => {
      ([
        { update: true,  index: 0, expected: true },
        { update: true,  index: 1, expected: true },
        { update: true,  index: 2, expected: true },
        { update: false, index: 0, expected: true },
        { update: false, index: 1, expected: true },
      ]).map((o) => it(`${o.update ? "With" : "Without"} update on tx[${o.index}], should be revertOnError: ${o.expected}`, async () => {
        const badtxs = await buildUpdateConfig({ appendUpdate: o.update })
        badtxs[o.index].revertOnError = !o.expected
        badtxs[o.index].gasLimit      = ethers.BigNumber.from(1000000)

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      }))
    })

    context("Bad 'value'", () => {
      ([
        { update: true,  index: 0, invalid: ethers.BigNumber.from(1) },
        { update: true,  index: 1, invalid: ethers.BigNumber.from(1) },
        { update: true,  index: 2, invalid: ethers.BigNumber.from(1) },
        { update: false, index: 0, invalid: ethers.BigNumber.from(1) },
        { update: false, index: 1, invalid: ethers.BigNumber.from(1) },
        { update: true,  index: 0, invalid: ethers.BigNumber.from(ethers.utils.parseEther("1000")) },
        { update: true,  index: 1, invalid: ethers.BigNumber.from(ethers.utils.parseEther("1000")) },
        { update: true,  index: 2, invalid: ethers.BigNumber.from(ethers.utils.parseEther("1000")) },
        { update: false, index: 0, invalid: ethers.BigNumber.from(ethers.utils.parseEther("1000")) },
        { update: false, index: 1, invalid: ethers.BigNumber.from(ethers.utils.parseEther("1000")) },
      ]).map((o) => it(`${o.update ? "With" : "Without"} update on tx[${o.index}], should not accept value: ${o.invalid.toString()}`, async () => {
        const badtxs = await buildUpdateConfig({ appendUpdate: o.update })
        badtxs[o.index].value = o.invalid

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      }))
    })

    context("Bad 'to'", () => {
      ([
        { update: true,  index: 0, invalid: "random" },
        { update: true,  index: 1, invalid: "random" },
        { update: true,  index: 2, invalid: "random" },
        { update: false, index: 0, invalid: "random" },
        { update: false, index: 1, invalid: "random" },

        { update: true,  index: 0, invalid: "sessionUtils" },
        { update: true,  index: 1, invalid: "sessionUtils" },
        { update: true,  index: 2, invalid: "self" },
        { update: false, index: 0, invalid: "sessionUtils" },
        { update: false, index: 1, invalid: "self" },
      ]).map((o) => it(`${o.update ? "With" : "Without"} update on tx[${o.index}], should not accept to: ${o.invalid}`, async () => {
        const badtxs = await buildUpdateConfig({ appendUpdate: o.update })
        const options = {
          "random": ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20))),
          "sessionUtils": sequenceContext.sequenceUtils,
          "self": wallet.address
        }

        badtxs[o.index].to = options[o.invalid]

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      }))
    })

    context("Bad 'gasLimit'", () => {
      ([
        { update: true,  index: 0, invalid: ethers.BigNumber.from(1) },
        { update: true,  index: 1, invalid: ethers.BigNumber.from(1) },
        { update: true,  index: 2, invalid: ethers.BigNumber.from(1) },
        { update: false, index: 0, invalid: ethers.BigNumber.from(1) },
        { update: false, index: 1, invalid: ethers.BigNumber.from(1) },
        { update: true,  index: 0, invalid: ethers.BigNumber.from(10000000) },
        { update: true,  index: 1, invalid: ethers.BigNumber.from(10000000) },
        { update: true,  index: 2, invalid: ethers.BigNumber.from(10000000) },
        { update: false, index: 0, invalid: ethers.BigNumber.from(10000000) },
        { update: false, index: 1, invalid: ethers.BigNumber.from(10000000) },
      ]).map((o) => it(`${o.update ? "With" : "Without"} update on tx[${o.index}], should not accept gasLimit: ${o.invalid.toString()}`, async () => {
        const badtxs = await buildUpdateConfig({ appendUpdate: o.update })
        badtxs[o.index].gasLimit = o.invalid

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      }))
    })

    context("Bad 'data'", () => {
      ([
        { update: true,  index: 0, invalid: "random" },
        { update: true,  index: 1, invalid: "random" },
        { update: true,  index: 2, invalid: "random" },
        { update: false, index: 0, invalid: "random" },
        { update: false, index: 1, invalid: "random" },

        { update: true,  index: 0, invalid: "empty" },
        { update: true,  index: 1, invalid: "empty" },
        { update: true,  index: 2, invalid: "empty" },
        { update: false, index: 0, invalid: "empty" },
        { update: false, index: 1, invalid: "empty" },

        { update: true,  index: 0, invalid: "extra00" },
        { update: true,  index: 1, invalid: "extra00" },
        { update: true,  index: 2, invalid: "extra00" },
        { update: false, index: 0, invalid: "extra00" },
        { update: false, index: 1, invalid: "extra00" },

        { update: true,  index: 0, invalid: "missing1byte" },
        { update: true,  index: 1, invalid: "missing1byte" },
        { update: true,  index: 2, invalid: "missing1byte" },
        { update: false, index: 0, invalid: "missing1byte" },
        { update: false, index: 1, invalid: "missing1byte" },
      ]).map((o) => it(`${o.update ? "With" : "missing1byte"} update on tx[${o.index}], should not accept data: ${o.invalid}`, async () => {
        const badtxs = await buildUpdateConfig({ appendUpdate: o.update })

        switch (o.invalid) {
          case "random":
            badtxs[o.index].data = ethers.utils.hexlify(ethers.utils.randomBytes(Math.floor(Math.random() * 256) + 1))
            break
          case "empty":
            badtxs[o.index].data = "0x"
            break
          case "extra00":
            badtxs[o.index].data = ethers.utils.hexlify(badtxs[o.index].data) + "00"
            break
          case "missing1byte":
            badtxs[o.index].data = ethers.utils.hexlify(badtxs[o.index].data).slice(0, -2)
            break
        }

        const signature = await wallet.signTransactions(badtxs, defaultChainId)
        const res = configTracker.savePresignedConfiguration(
          buildSavePresignedConf({
            txs: badtxs,
            signature
          })
        )

        await expect(res).to.be.rejected
      }))
    })
  })

  describe("Sequence wallet", () => {
    const KnownNetworkIds = [
      defaultChainId,  // Mainnet (fake, just hardhat)
      3,               // Ropsten
      4,               // Rinkeby
      5,               // Goerli
      42,              // Kovan
      56,              // Binance Smart Chain
      43114,           // Avalanche C-Chain
      250,             // Fantom Opera
      137,             // Polygon Mainnet
      25,              // Cronos Mainnet
      42161,           // Arbitrum One
      8217,            // Klaytn
      10,              // Optimism
      42220,           // Celo
      128,             // Huobi
      361,             // Theta
      100,             // Gnosis chain
      30,              // RSK
      80001,           // Polygon Mumbai
      200,             // Arbitrum on xDai
      421611,          // Arbitrum Rinkeby
      69,              // Optimism kovan
      300,             // Optimism testnet
      61,              // Ethereum classic
      1313161554,      // Aurora
      1666600000,      // Harmony
    ]

    it("Should handle simple wallet case", async () => {
      // Wallet A --> Wallet B -
      //          \             \
      //           ---------------> Wallet C
  
      const torus = ethers.Wallet.createRandom()
      const guard = ethers.Wallet.createRandom()
      const session1 = ethers.Wallet.createRandom()
      const session2 = ethers.Wallet.createRandom()
      const session3 = ethers.Wallet.createRandom()
      const session4 = ethers.Wallet.createRandom()

      // Initial config
      const config: WalletConfig = {
        threshold: 3,
        signers: [{
          address: torus.address,
          weight: 2
        }, {
          address: guard.address,
          weight: 2
        }, {
          address: session1.address,
          weight: 1
        }]
      }

      // Open session with session1
      let account = await Account.create(options, config, torus, session1)
      const witnessMessage = `0xSequence witness: ${ethers.utils.hexlify(ethers.utils.randomBytes(32))}`
      const witnessDigest = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(witnessMessage))
      const signed = await account.signMessage(witnessDigest, defaultChainId, undefined, true)
      await configTracker.saveWitness({ wallet: account.address, digest: witnessDigest, signatures: [{ signature: signed, chainId: defaultChainId }] })

      // Recover session using torus address
      const found = await configTracker.walletsOfSigner({ signer: torus.address })
      expect(found.length).to.equal(1)
      expect(found[0].wallet).to.equal(account.address)

      // Update config with new session
      const config2 = { ...config, signers: [...config.signers, {
          address: session2.address,
          weight: 1
        }]
      }

      await account.useSigners(torus, guard).updateConfig(config2, defaultChainId, KnownNetworkIds)

      // Presigned path should lead to new config2 (on every known chain id and on default chain id)
      await Promise.all(KnownNetworkIds.map(async (cid) => {
        const res = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config),
          prependUpdate: [sequenceContext.mainModuleUpgradable]
        })

        expect(res.length).to.equal(1)
        expectValidRoute(res, {
          wallet: account.address,
          chainId: cid,
          route: [config, config2],
          update: sequenceContext.mainModuleUpgradable,
        })
      }))

      // Add a new session
      const found2 = await configTracker.walletsOfSigner({ signer: torus.address })
      expect(found2.length).to.equal(1)
      expect(found2[0].wallet).to.equal(account.address)

      const config3 = { ...config, signers: [...config.signers, {
          address: session3.address,
          weight: 1
        }]
      }

      await account.useSigners(torus, guard).updateConfig(config3, defaultChainId, KnownNetworkIds)

      // Presigned path should lead to new config3 (on every known chain id and on default chain id)
      await Promise.all(KnownNetworkIds.map(async (cid) => {
        const res = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config),
          prependUpdate: [sequenceContext.mainModuleUpgradable]
        })

        expect(res.length).to.equal(2)
        expectValidRoute(res, {
          wallet: account.address,
          chainId: cid,
          route: [config, config2, config3],
          update: sequenceContext.mainModuleUpgradable,
        })

        // config2 to config3 exists
        const res2 = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config2),
          prependUpdate: []
        })
        expect(res2.length).to.equal(1)
        expectValidRoute(res2, {
          wallet: account.address,
          chainId: cid,
          route: [config2, config3],
        })

        // from config2 to config3 with update also exists
        // but it updates to config2 again, just to do the update
        const res3 = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config2),
          prependUpdate: [sequenceContext.mainModuleUpgradable]
        })
        expect(res3.length).to.equal(2)
        expectValidRoute(res3, {
          wallet: account.address,
          chainId: cid,
          route: [config2, config2, config3],
          update: sequenceContext.mainModuleUpgradable,
        })
      }))

      // Remove session2
      const config4 = { ...config3, signers: config3.signers.filter((s) => s.address !== session2.address) }
      await account.useSigners(guard, session2).updateConfig(config4, defaultChainId, KnownNetworkIds)

      // Presigned path should lead to new config4 (on every known chain id and on default chain id)
      await Promise.all(KnownNetworkIds.map(async (cid) => {
        // From config to config4
        const res = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config),
          prependUpdate: [sequenceContext.mainModuleUpgradable]
        })
        expect(res.length).to.equal(2)
        expectValidRoute(res, {
          wallet: account.address,
          chainId: cid,
          route: [config, config2, config4],
          update: sequenceContext.mainModuleUpgradable,
        })

        // From config3 to config4 (with config2 to update)
        const res2 = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config3),
          prependUpdate: [sequenceContext.mainModuleUpgradable]
        })
        expect(res2.length).to.equal(2)
        expectValidRoute(res2, {
          wallet: account.address,
          chainId: cid,
          route: [config3, config2, config4],
          update: sequenceContext.mainModuleUpgradable,
        })

        // Without update it goes directly
        const res3 = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config3),
          prependUpdate: []
        })
        expect(res3.length).to.equal(1)
        expectValidRoute(res3, {
          wallet: account.address,
          chainId: cid,
          route: [config3, config4],
        })
      }))

      // Add one more session
      const found3 = await configTracker.walletsOfSigner({ signer: torus.address })
      expect(found3.length).to.equal(1)
      expect(found3[0].wallet).to.equal(account.address)

      account = new Account({ ...options, address: found3[0].wallet }, torus, guard)

      const config5 = { ...config4, signers: [...config4.signers, {
          address: session4.address,
          weight: 1
        }]
      }

      await account.updateConfig(config5, defaultChainId, KnownNetworkIds)

      // Presigned path should lead to new config5 (on every known chain id and on default chain id)
      await Promise.all(KnownNetworkIds.map(async (cid) => {
        // From config to config5
        const res = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config),
          prependUpdate: [sequenceContext.mainModuleUpgradable]
        })
        expect(res.length).to.equal(2)
        expectValidRoute(res, {
          wallet: account.address,
          chainId: cid,
          route: [config, config2, config5],
          update: sequenceContext.mainModuleUpgradable,
        })

        // From config2 goes directly (without update)
        const res2 = await configTracker.loadPresignedConfiguration({
          wallet: account.address,
          chainId: cid,
          fromImageHash: imageHash(config2),
          prependUpdate: []
        })
        expect(res2.length).to.equal(1)
        expectValidRoute(res2, {
          wallet: account.address,
          chainId: cid,
          route: [config2, config5],
        })
      }))
    })
  })
})
