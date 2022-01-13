import { useCallback, useMemo } from "react"
import { atom, useRecoilState } from "recoil"
import { encode } from "js-base64"
import { AccAddress, SignDoc } from "@terra-money/terra.js"
import { CreateTxOptions, Tx, isTxError } from "@terra-money/terra.js"
import { PublicKey, RawKey, SignatureV2 } from "@terra-money/terra.js"
import { useChainID } from "data/wallet"
import { useLCDClient } from "data/queries/lcdClient"
import is from "../scripts/is"
import { PasswordError } from "../scripts/keystore"
import { getDecryptedKey, testPassword } from "../scripts/keystore"
import { getWallet, storeWallet, clearWallet } from "../scripts/keystore"
import { getStoredWallet, getStoredWallets } from "../scripts/keystore"
import encrypt from "../scripts/encrypt"
import * as ledger from "../ledger/ledger"
import LedgerKey from "../ledger/LedgerKey"
import useAvailable from "./useAvailable"

const walletState = atom({
  key: "wallet",
  default: getWallet(),
})

const useAuth = () => {
  const lcd = useLCDClient()
  const available = useAvailable()

  const [wallet, setWallet] = useRecoilState(walletState)
  const wallets = getStoredWallets()

  /* connect | disconnect */
  const connect = useCallback(
    (name: string) => {
      const storedWallet = getStoredWallet(name)
      const { address } = storedWallet

      const wallet = is.multisig(storedWallet)
        ? { name, address, multisig: true }
        : { name, address }

      storeWallet(wallet)
      setWallet(wallet)
    },
    [setWallet]
  )

  const connectLedger = useCallback(
    (address: AccAddress) => {
      const wallet = { address, ledger: true as const }
      storeWallet(wallet)
      setWallet(wallet)
    },
    [setWallet]
  )

  const disconnect = useCallback(() => {
    clearWallet()
    setWallet(undefined)
  }, [setWallet])

  /* helpers */
  const connectedWallet = useMemo(() => {
    if (!is.local(wallet)) return
    return wallet
  }, [wallet])

  const getConnectedWallet = () => {
    if (!connectedWallet) throw new Error("Wallet is not defined")
    return connectedWallet
  }

  const getKey = (password: string) => {
    const { name } = getConnectedWallet()
    return getDecryptedKey({ name, password })
  }

  const getLedgerKey = async () => {
    const pk = await ledger.getPubKey()
    if (!pk) throw new Error("Public key is not defined")

    const publicKey = PublicKey.fromAmino({
      type: "tendermint/PubKeySecp256k1",
      value: pk.toString("base64"),
    })

    const key = new LedgerKey(publicKey)
    return key
  }

  /* manage: export */
  const encodeEncryptedWallet = (password: string) => {
    const { name, address } = getConnectedWallet()
    const key = getKey(password)
    const data = { name, address, encrypted_key: encrypt(key, password) }
    return encode(JSON.stringify(data))
  }

  /* form */
  const validatePassword = (password: string) => {
    try {
      const { name } = getConnectedWallet()
      return testPassword({ name, password })
    } catch (error) {
      return "Incorrect password"
    }
  }

  /* tx */
  const chainID = useChainID()

  const create = async (txOptions: CreateTxOptions) => {
    if (!wallet) throw new Error("Wallet is not defined")
    const { address } = wallet
    return await lcd.tx.create([{ address }], txOptions)
  }

  const createSignature = async (
    tx: Tx,
    address: AccAddress,
    password = ""
  ) => {
    if (!wallet) throw new Error("Wallet is not defined")

    const accountInfo = await lcd.auth.accountInfo(address)

    const doc = new SignDoc(
      lcd.config.chainID,
      accountInfo.getAccountNumber(),
      accountInfo.getSequenceNumber(),
      tx.auth_info,
      tx.body
    )

    if (is.ledger(wallet)) {
      const key = await getLedgerKey()
      return await key.createSignatureAmino(doc)
    } else {
      const pk = getKey(password)
      if (!pk) throw new PasswordError("Incorrect password")
      const key = new RawKey(Buffer.from(pk, "hex"))
      return await key.createSignatureAmino(doc)
    }
  }

  const sign = async (txOptions: CreateTxOptions, password = "") => {
    if (!wallet) throw new Error("Wallet is not defined")

    if (is.ledger(wallet)) {
      const key = await getLedgerKey()
      const wallet = lcd.wallet(key)
      const { account_number: accountNumber, sequence } =
        await wallet.accountNumberAndSequence()
      const signMode = SignatureV2.SignMode.SIGN_MODE_LEGACY_AMINO_JSON
      const unsignedTx = await create(txOptions)
      const options = { chainID, accountNumber, sequence, signMode }
      return await key.signTx(unsignedTx, options)
    } else {
      const pk = getKey(password)
      if (!pk) throw new PasswordError("Incorrect password")
      const key = new RawKey(Buffer.from(pk, "hex"))
      const wallet = lcd.wallet(key)
      return await wallet.createAndSignTx(txOptions)
    }
  }

  const signBytes = (bytes: Buffer, password = "") => {
    if (!wallet) throw new Error("Wallet is not defined")

    if (is.ledger(wallet)) {
      throw new Error("Ledger can not sign arbitrary data")
    } else {
      const pk = getKey(password)
      if (!pk) throw new PasswordError("Incorrect password")
      const key = new RawKey(Buffer.from(pk, "hex"))
      const { signature, recid } = key.ecdsaSign(bytes)
      if (!signature) throw new Error("Signature is undefined")
      return {
        recid,
        signature: Buffer.from(signature).toString("base64"),
        public_key: key.publicKey?.toAmino().value as string,
      }
    }
  }

  const post = async (txOptions: CreateTxOptions, password = "") => {
    if (!wallet) throw new Error("Wallet is not defined")
    const signedTx = await sign(txOptions, password)
    const result = await lcd.tx.broadcastSync(signedTx)
    if (isTxError(result)) throw new Error(result.raw_log)
    return result
  }

  return {
    wallet,
    wallets,
    getConnectedWallet,
    connectedWallet,
    connect,
    connectLedger,
    disconnect,
    available,
    encodeEncryptedWallet,
    validatePassword,
    createSignature,
    create,
    signBytes,
    sign,
    post,
  }
}

export default useAuth
