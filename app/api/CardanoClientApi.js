// @flow
import localStorage from 'electron-json-storage';
import ClientApi from 'daedalus-client-api';
import { action } from 'mobx';
import { ipcRenderer } from 'electron';
import Log from 'electron-log';
import BigNumber from 'bignumber.js';
import Wallet from '../domain/Wallet';
import WalletTransaction from '../domain/WalletTransaction';
import type {
  createWalletRequest,
  getTransactionsRequest,
  createTransactionRequest,
  walletRestoreRequest,
  walletUpdateRequest,
  redeemAdaRequest,
  redeemPaperVendedAdaRequest,
  importKeyRequest,
  deleteWalletRequest
} from './index';
import {
  // ApiMethodNotYetImplementedError,
  GenericApiError,
  WalletAlreadyRestoredError,
  RedeemAdaError,
  WalletKeyImportError,
  NotEnoughMoneyToSendError
} from './errors';
import type { AssuranceModeOption } from '../types/transactionAssuranceTypes';
import { LOVELACES_PER_ADA } from '../config/numbersConfig';

// const notYetImplemented = () => new Promise((_, reject) => {
//   reject(new ApiMethodNotYetImplementedError());
// });

// Commented out helper code for testing async APIs
// (async () => {
//   const result = await ClientApi.nextUpdate();
//   console.log('nextUpdate', result);
// })();

// Commented out helper code for testing sync APIs
// (() => {
//   const result = ClientApi.isValidRedeemCode('HSoXEnt9X541uHvtzBpy8vKfTo1C9TkAX3wat2c6ikg=');
//   console.log('isValidRedeemCode', result);
// })();

const getUserLocaleFromLocalStorage = () => new Promise((resolve, reject) => {
  localStorage.get('userLocale', (error, response) => {
    if (error) return reject(error);
    if (!response.locale) return resolve('');
    resolve(response.locale);
  });
});

const setUserLocaleInLocalStorage = (locale) => new Promise((resolve, reject) => {
  localStorage.set('userLocale', { locale }, (error) => {
    if (error) return reject(error);
    resolve();
  });
});

export default class CardanoClientApi {

  notifyCallbacks = [];

  constructor() {
    ClientApi.notify(this._onNotify, this._onNotifyError);
  }

  notify(onSuccess: Function, onError: Function = () => {}) {
    this.notifyCallbacks.push({ message: onSuccess, error: onError });
  }

  reset() {
    this.notifyCallbacks = [];
  }

  async getWallets() {
    Log.debug('CardanoClientApi::getWallets called');
    const response = await ClientApi.getWallets();
    return response.map(data => _createWalletFromServerData(data));
  }

  async getTransactions(request: getTransactionsRequest) {
    const { walletId, searchTerm, skip, limit } = request;
    Log.debug('CardanoClientApi::getTransactions called with', request);
    const history = await ClientApi.searchHistory(walletId, searchTerm, skip, limit);
    return new Promise((resolve) => resolve({
      transactions: history[0].map(data => _createTransactionFromServerData(data, walletId)),
      total: history[1]
    }));
  }

  async createWallet(request: createWalletRequest) {
    Log.debug('CardanoClientApi::createWallet called with', request);
    const response = await ClientApi.newWallet('CWTPersonal', 'ADA', request.name, request.mnemonic);
    return _createWalletFromServerData(response);
  }

  async deleteWallet(request: deleteWalletRequest) {
    try {
      await ClientApi.deleteWallet(request.walletId);
      return true;
    } catch (error) {
      throw new GenericApiError();
    }
  }

  async createTransaction(request: createTransactionRequest) {
    Log.debug('CardanoClientApi::createTransaction called with', request);
    const { sender, receiver, amount, currency } = request;
    const description = 'no description provided';
    const title = 'no title provided';
    try {
      const response = await ClientApi.sendExtended(
        sender, receiver, amount, currency, title, description
      );
      return _createTransactionFromServerData(response);
    } catch (error) {
      if (error.message.includes('Not enough money to send')) {
        throw new NotEnoughMoneyToSendError();
      }
      throw new GenericApiError();
    }
  }

  isValidAddress(currency: string, address: string): Promise<bool> {
    return ClientApi.isValidAddress(currency, address);
  }

  isValidMnemonic(mnemonic: string): Promise<bool> { // eslint-disable-line
    return ClientApi.isValidMnemonic(12, mnemonic);
  }

  isValidRedemptionKey(mnemonic: string): Promise<bool> {
    return ClientApi.isValidRedeemCode(mnemonic);
  }

  isValidPostVendRedeemCode(redeemCode: string): Promise<bool> {
    return ClientApi.isValidPostVendRedeemCode(redeemCode);
  }

  isValidRedemptionMnemonic(mnemonic: string): Promise<bool> {
    return ClientApi.isValidMnemonic(9, mnemonic);
  }

  getWalletRecoveryPhrase() {
    return new Promise((resolve) => resolve(ClientApi.generateMnemonic().split(' ')));
  }

  async restoreWallet(request: walletRestoreRequest) {
    const { recoveryPhrase, walletName } = request;
    Log.debug('CardanoClientApi::restoreWallet called with', request);
    try {
      const restoredWallet = await ClientApi.restoreWallet('CWTPersonal', 'ADA', walletName, recoveryPhrase);
      return _createWalletFromServerData(restoredWallet);
    } catch (error) {
      Log.error('Error restoring a wallet', error);
      // TODO: backend will return something different here, if multiple wallets
      // are restored from the key and if there are duplicate wallets we will get
      // some kind of error and present the user with message that some wallets
      // where not imported/restored if some where. if no wallets are imported
      // we will error out completely with throw block below
      if (error.message.includes('Wallet with that mnemonics already exists')) {
        throw new WalletAlreadyRestoredError();
      }
      // We don't know what the problem was -> throw generic error
      throw new GenericApiError();
    }
  }

  async importWalletFromKey(request: importKeyRequest) {
    Log.debug('CardanoClientApi::importWalletFromKey called with', request);
    try {
      const importedWallet = await ClientApi.importKey(request.filePath);
      return _createWalletFromServerData(importedWallet);
    } catch (error) {
      console.error(error);
      if (error.message.includes('Wallet with that mnemonics already exists')) {
        throw new WalletAlreadyRestoredError();
      }
      throw new WalletKeyImportError();
    }
  }

  async redeemAda(request: redeemAdaRequest) {
    const { redemptionCode, walletId } = request;
    Log.debug('CardanoClientApi::redeemAda called with', request);
    try {
      const response: ServerWalletStruct = await ClientApi.redeemADA(redemptionCode, walletId);
      return _createTransactionFromServerData(response);
    } catch (error) {
      console.error(error);
      throw new RedeemAdaError();
    }
  }

  async redeemPaperVendedAda(request: redeemPaperVendedAdaRequest) {
    const { shieldedRedemptionKey, mnemonics, walletId } = request;
    console.log('REQUEST', request);
    Log.debug('CardanoClientApi::redeemPaperVendedAda called with', request);
    try {
      const response: ServerWalletStruct =
        await ClientApi.postVendRedeemADA(shieldedRedemptionKey, mnemonics, walletId);
      console.log('RESPONSE', response);
      return _createTransactionFromServerData(response);
    } catch (error) {
      console.error(error);
      throw new RedeemAdaError();
    }
  }

  generateMnemonic() {
    return ClientApi.generateMnemonic().split(' ');
  }

  // PRIVATE

  _onNotify = (rawMessage: string) => {
    Log.debug('CardanoClientApi::notify message: ', rawMessage);
    // TODO: "ConnectionClosed" messages are not JSON parsable … so we need to catch that case here!
    let message = rawMessage;
    if (message !== 'ConnectionClosed') {
      message = JSON.parse(rawMessage);
    }
    this.notifyCallbacks.forEach(cb => cb.message(message));
  };

  _onNotifyError = (error: Error) => {
    Log.debug('CardanoClientApi::notify error: ', error);
    this.notifyCallbacks.forEach(cb => cb.error(error));
  };


  async nextUpdate() {
    Log.debug('CardanoClientApi::nextUpdate called');
    let nextUpdate = null;
    try {
      nextUpdate = JSON.parse(await ClientApi.nextUpdate());
      Log.debug('CardanoClientApi::nextUpdate returned', nextUpdate);
    } catch (error) {
      Log.debug(error);
      // TODO: Api is trowing an error when update is not available, handle other errors
    }
    return nextUpdate;
    // TODO: remove hardcoded response after node update is tested
    // nextUpdate = {
    //   cuiSoftwareVersion: {
    //     svAppName: {
    //       getApplicationName: "cardano"
    //     },
    //     svNumber: 1
    //   },
    //   cuiBlockVesion: {
    //     bvMajor: 0,
    //     bvMinor: 1,
    //     bvAlt: 0
    //   },
    //   cuiScriptVersion: 1,
    //   cuiImplicit: false,
    //   cuiVotesFor: 2,
    //   cuiVotesAgainst: 0,
    //   cuiPositiveStake: {
    //     getCoin: 66666
    //   },
    //   cuiNegativeStake: {
    //     getCoin: 0
    //   }
    // };
    // if (nextUpdate && nextUpdate.cuiSoftwareVersion && nextUpdate.cuiSoftwareVersion.svNumber) {
    //   return { version: nextUpdate.cuiSoftwareVersion.svNumber };
    // } else if (nextUpdate) {
    //   return { version: 'Unknown' };
    // }
    // return null;
  }

  async applyUpdate() {
    await ClientApi.applyUpdate();
    ipcRenderer.send('kill-process');
  }

  async getSyncProgress() {
    Log.debug('CardanoClientApi::syncProgress called');
    const response = await ClientApi.syncProgress();
    Log.debug('CardanoClientApi::syncProgress response', response);
    const localDifficulty = response._spLocalCD.getChainDifficulty;
    // In some cases we dont get network difficulty & we need to wait for it from the notify API
    let networkDifficulty = null;
    if (response._spNetworkCD) networkDifficulty = response._spNetworkCD.getChainDifficulty;
    return { localDifficulty, networkDifficulty };
  }

  async setUserLocale(locale: string) {
    try {
      await setUserLocaleInLocalStorage(locale);
      return locale;
    } catch (error) {
      Log.error('Error setting user locale to local storage', error);
      throw new GenericApiError();
    }
  }

  async getUserLocale() {
    try {
      return await getUserLocaleFromLocalStorage();
    } catch (error) {
      Log.error('Error reading user locale from local storage', error);
      throw new GenericApiError();
    }
  }

  async updateWallet(request: walletUpdateRequest) {
    const { walletId, type, currency, name, assurance } = request;
    try {
      return await ClientApi.updateWallet(walletId, type, currency, name, assurance, 0);
    } catch (error) {
      Log.error('Error updating a wallet', error);
      throw new GenericApiError();
    }
  }

  testReset() {
    return ClientApi.testReset();
  }
}

type ServerCoinAmountStruct = {
  getCoin: number,
};

type ServerWalletStruct = {
  cwAddress: string,
  cwAmount: ServerCoinAmountStruct,
  cwMeta: {
    cwName: string,
    cwType: string,
    cwCurrency: string,
    cwUnit: number,
    cwAssurance: AssuranceModeOption,
  },
}

type ServerTransactionStruct = {
  ctId: string,
  ctType: {
    tag: string,
    contents: {
      ctmDate: Date,
      ctmTitle: ?string,
      ctmDescription: ?string,
    }
  },
  ctAmount: ServerCoinAmountStruct,
  ctConfirmations: number,
}

// ========== TRANSFORM SERVER DATA INTO FRONTEND MODELS =========

const _createWalletFromServerData = action((data: ServerWalletStruct) => (
  new Wallet({
    id: data.cwAddress,
    address: data.cwAddress,
    amount: new BigNumber(data.cwAmount.getCoin).dividedBy(LOVELACES_PER_ADA),
    type: data.cwMeta.cwType,
    currency: data.cwMeta.cwCurrency,
    name: data.cwMeta.cwName,
    assurance: data.cwMeta.cwAssurance,
  })
));

const _createTransactionFromServerData = action((data: ServerTransactionStruct) => {
  const isOutgoing = data.ctType.tag === 'CTOut';
  const coins = data.ctAmount.getCoin;
  const { ctmTitle, ctmDescription, ctmDate } = data.ctType.contents;
  return new WalletTransaction({
    id: data.ctId,
    title: ctmTitle || isOutgoing ? 'Ada sent' : 'Ada received',
    type: isOutgoing ? 'adaExpend' : 'adaIncome',
    currency: 'ada',
    amount: new BigNumber(isOutgoing ? -1 * coins : coins).dividedBy(LOVELACES_PER_ADA),
    date: new Date(ctmDate * 1000),
    description: ctmDescription || '',
    numberOfConfirmations: data.ctConfirmations,
  });
});
