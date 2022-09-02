import axios from 'axios';
import EventEmitter from 'events';
import {randomBytes} from 'crypto';
import SteamID from 'steamid';

import AuthenticationClient from './AuthenticationClient';
import ITransport from './transports/ITransport';
import EAuthTokenPlatformType from './enums-steam/EAuthTokenPlatformType';
import WebApiTransport from './transports/WebApiTransport';
import {
	StartLoginSessionWithCredentialsDetails,
	StartSessionResponse,
	StartSessionResponseValidAction
} from './interfaces-external';
import {CheckMachineAuthResponse, StartAuthSessionWithCredentialsResponse} from './interfaces-internal';
import ESessionPersistence from './enums-steam/ESessionPersistence';
import EAuthSessionGuardType from './enums-steam/EAuthSessionGuardType';
import EResult from './enums-steam/EResult';
import {API_HEADERS, decodeJwt, eresultError} from './helpers';
import Timeout = NodeJS.Timeout;

export default class LoginSession extends EventEmitter {
	loginTimeout: number;

	accountName?: string; // we don't validate this at all
	_accessToken?: string;
	_refreshToken?: string;

	_platformType: EAuthTokenPlatformType;
	_handler: AuthenticationClient;

	_steamGuardCode?: string;
	_steamGuardMachineToken?: string;
	_startSessionResponse?: StartAuthSessionWithCredentialsResponse;
	_hadRemoteInteraction?: boolean;

	_pollingStartedTime?: number;
	_pollTimer?: Timeout;
	_pollingCanceled?: boolean;

	/**
	 * @param {EAuthTokenPlatformType} [platformType=WebBrowser]
	 * @param {ITransport} [transport=WebApiTransport]
	 */
	constructor(platformType?: EAuthTokenPlatformType, transport?: ITransport) {
		super();

		this._platformType = platformType || EAuthTokenPlatformType.WebBrowser;
		this._handler = new AuthenticationClient(transport || new WebApiTransport());

		this.loginTimeout = 30000;
	}

	get steamID(): SteamID {
		// There's a few places we could get a steamid from
		if (this._startSessionResponse) {
			return new SteamID(this._startSessionResponse.steamId);
		} else if (this.accessToken || this.refreshToken) {
			let token = this.accessToken || this.refreshToken;
			let decodedToken = decodeJwt(token);
			return new SteamID(decodedToken.sub);
		} else {
			return null;
		}
	}

	get accessToken(): string { return this._accessToken; }
	get refreshToken(): string { return this._refreshToken; }

	set accessToken(token: string) {
		if (!token) {
			this._accessToken = token;
			return;
		}

		let decoded = decodeJwt(token);

		try { new SteamID(decoded.sub); } catch {
			throw new Error('Not a valid Steam access token');
		}

		if (this._startSessionResponse && this._startSessionResponse.steamId && decoded.sub != this._startSessionResponse.steamId) {
			throw new Error('Token is for a different account. To work with a different account, create a new LoginSession.');
		}

		if (this._refreshToken) {
			let decodedRefreshToken = decodeJwt(this._refreshToken);
			if (decodedRefreshToken.sub != decoded.sub) {
				throw new Error('This access token belongs to a different account from the set refresh token.');
			}
		}

		// Everything checks out
		this._accessToken = token;
	}

	set refreshToken(token: string) {
		if (!token) {
			this._refreshToken = token;
			return;
		}

		let decoded = decodeJwt(token);

		try { new SteamID(decoded.sub); } catch {
			throw new Error('Not a valid Steam access token');
		}

		if (this._startSessionResponse && this._startSessionResponse.steamId && decoded.sub != this._startSessionResponse.steamId) {
			throw new Error('Token is for a different account. To work with a different account, create a new LoginSession.');
		}

		if (this._accessToken) {
			let decodedAccessToken = decodeJwt(this._accessToken);
			if (decodedAccessToken.sub != decoded.sub) {
				throw new Error('This refresh token belongs to a different account from the set access token.');
			}
		}

		// Everything checks out
		this._refreshToken = token;
	}

	get _defaultWebsiteId() {
		switch (this._platformType) {
			case EAuthTokenPlatformType.SteamClient:
				return '';

			case EAuthTokenPlatformType.WebBrowser:
				return 'Community';

			case EAuthTokenPlatformType.MobileApp:
				return 'MobileApp'; // TODO confirm this

			default:
				return 'Community';
		}
	}

	_verifyStarted() {
		if (!this._startSessionResponse) {
			throw new Error('Login session has not been started yet');
		}
	}

	async startWithCredentials(details: StartLoginSessionWithCredentialsDetails): Promise<StartSessionResponse> {
		this._hadRemoteInteraction = false;
		this._steamGuardCode = details.steamGuardCode;
		this._steamGuardMachineToken = details.steamGuardMachineToken;

		let encryptionResult = await this._handler.encryptPassword(details.accountName, details.password);

		this._startSessionResponse = await this._handler.startSessionWithCredentials({
			deviceFriendlyName: details.deviceFriendlyName,
			accountName: details.accountName,
			...encryptionResult,
			persistence: details.persistence || ESessionPersistence.Persistent,
			platformType: this._platformType,
			websiteId: details.websiteId || this._defaultWebsiteId
		});

		this.emit('debug', 'start session response', this._startSessionResponse);

		// Use setImmediate so that the promise is resolved before we potentially emit a session
		return await this._processStartSessionResponse();
	}

	async _processStartSessionResponse(): Promise<StartSessionResponse> {
		this._pollingCanceled = false;

		let validActions:StartSessionResponseValidAction[] = [];

		for (let i of this._startSessionResponse.allowedConfirmations) {
			switch (i.type) {
				case EAuthSessionGuardType.None:
					this.emit('debug', 'no guard required');
					// Use setImmediate here so that the promise is resolved before we potentially emit a session
					setImmediate(() => this._doPoll());
					return {actionRequired: false};

				case EAuthSessionGuardType.EmailCode:
				case EAuthSessionGuardType.DeviceCode:
					let codeType = i.type == EAuthSessionGuardType.EmailCode ? 'email' : 'device';
					this.emit('debug', `${codeType} code required`);

					let authResult = await (codeType == 'email' ? this._attemptEmailCodeAuth() : this._attemptTotpCodeAuth());
					if (authResult) {
						// We successfully authed already, no action needed
						return {actionRequired: false};
					} else {
						// We need a code from the user
						let action:StartSessionResponseValidAction = {type: i.type};
						if (i.message) {
							action.detail = i.message;
						}
						validActions.push(action);
						break;
					}

				case EAuthSessionGuardType.DeviceConfirmation:
				case EAuthSessionGuardType.EmailConfirmation:
					this.emit('debug', 'device or email confirmation guard required');
					validActions.push({type: i.type});
					setImmediate(() => this._doPoll());
					break;

				case EAuthSessionGuardType.MachineToken:
					// Do nothing here since this is handled by _attemptEmailCodeAuth
					break;

				default:
					let guardTypeString:string = i.type.toString();
					for (let j in EAuthSessionGuardType) {
						if (EAuthSessionGuardType[j] == guardTypeString) {
							guardTypeString = j;
							break;
						}
					}

					throw new Error(`Unknown auth session guard type ${guardTypeString}`);
			}
		}

		// If we got here but we have no valid actions, something went wrong
		if (validActions.length == 0) {
			throw new Error('Login requires action, but we can\'t tell what kind of action is required');
		}

		return {
			actionRequired: true,
			validActions
		};
	}

	async _doPoll() {
		if (this._pollingCanceled) {
			return;
		}

		// If we called _doPoll outside of an existing timer, cancel the timer
		clearTimeout(this._pollTimer);

		if (!this._pollingStartedTime) {
			this._pollingStartedTime = Date.now();
			this.emit('polling');
		}

		let totalPollingTime = Date.now() - this._pollingStartedTime;
		if (totalPollingTime >= this.loginTimeout) {
			this.emit('timeout');
			this.cancelLoginAttempt();
			return;
		}

		let pollResponse;
		try {
			pollResponse = await this._handler.pollLoginStatus(this._startSessionResponse);
			this.emit('debug', 'poll response', pollResponse);
		} catch (ex) {
			this.emit('error', ex);
			return;
		}

		this._startSessionResponse.clientId = pollResponse.newClientId || this._startSessionResponse.clientId;

		if (pollResponse.hadRemoteInteraction && !this._hadRemoteInteraction) {
			this._hadRemoteInteraction = true;
			this.emit('remoteInteraction');
		}

		if (pollResponse.accessToken) {
			this.accountName = pollResponse.accountName;
			this.accessToken = pollResponse.accessToken;
			this.refreshToken = pollResponse.refreshToken;
			this.emit('authenticated');
		} else if (!this._pollingCanceled) {
			this._pollTimer = setTimeout(() => this._doPoll(), this._startSessionResponse.pollInterval * 1000);
		}
	}

	/**
	 * @returns {boolean} - true if code submitted successfully, false if code wasn't valid or no code available
	 */
	async _attemptEmailCodeAuth(): Promise<boolean> {
		if (this._steamGuardCode) {
			try {
				await this.submitSteamGuardCode(this._steamGuardCode);
				return true;
			} catch (ex) {
				if (ex.eresult != EResult.InvalidLoginAuthCode) {
					// this is some kind of important error
					throw ex;
				}
			}
		}

		// Can we use a machine auth token?
		if (this._startSessionResponse.allowedConfirmations.some(c => c.type == EAuthSessionGuardType.MachineToken)) {
			let result:CheckMachineAuthResponse;
			try {
				result = await this._handler.checkMachineAuthOrSendCodeEmail({
					machineAuthToken: this._steamGuardMachineToken,
					...this._startSessionResponse
				});
			} catch (ex) {
				throw ex;
			}

			if (result.result == EResult.OK) {
				// Machine auth succeeded
				setImmediate(() => this._doPoll());
				return true;
			}
		}

		// An email was sent
		return false;
	}

	async _attemptTotpCodeAuth(): Promise<boolean> {
		if (this._steamGuardCode) {
			try {
				await this.submitSteamGuardCode(this._steamGuardCode);
				return true; // submitting code succeeded
			} catch (ex) {
				if (ex.eresult != EResult.TwoFactorCodeMismatch) {
					// this is some kind of important error
					throw ex;
				}
			}
		}

		// If we got here, then we need the user to supply a code
		return false;
	}

	async submitSteamGuardCode(authCode: string) {
		this._verifyStarted();

		this.emit('debug', 'submitting steam guard code', authCode);

		let needsEmailCode = this._startSessionResponse.allowedConfirmations.some(c => c.type == EAuthSessionGuardType.EmailCode);
		let needsTotpCode = this._startSessionResponse.allowedConfirmations.some(c => c.type == EAuthSessionGuardType.DeviceCode);
		if (!needsEmailCode && !needsTotpCode) {
			throw new Error('No Steam Guard code is needed for this login attempt');
		}

		await this._handler.submitSteamGuardCode({
			...this._startSessionResponse,
			authCode,
			authCodeType: needsEmailCode ? EAuthSessionGuardType.EmailCode : EAuthSessionGuardType.DeviceCode
		});

		setImmediate(() => this._doPoll());
	}

	cancelLoginAttempt(): boolean {
		this._pollingCanceled = true;

		if (this._pollTimer) {
			clearTimeout(this._pollTimer);
			return true;
		}

		return false;
	}

	async getWebCookies(): Promise<string[]> {
		if (!this.refreshToken) {
			throw new Error('A refresh token is required to get web cookies');
		}

		let finalizeResponse = await axios({
			method: 'POST',
			url: 'https://login.steampowered.com/jwt/finalizelogin',
			headers: {'content-type': 'multipart/form-data', ...API_HEADERS},
			data: {
				nonce: this.refreshToken,
				sessionid: randomBytes(12).toString('hex'),
				redir: 'https://steamcommunity.com/login/home/?goto='
			}
		});

		if (finalizeResponse.data && finalizeResponse.data.error) {
			throw eresultError(finalizeResponse.data.error);
		}

		if (!finalizeResponse.data || !finalizeResponse.data.transfer_info) {
			throw new Error('Malformed login response');
		}

		// Now we want to execute all transfers specified in the finalizelogin response. Technically we only need one
		// successful transfer (hence the usage of promsieAny), but we execute them all for robustness in case one fails.
		// As long as one succeeds, we're good.
		let transfers = finalizeResponse.data.transfer_info.map(({url, params}) => new Promise(async (resolve, reject) => {
			let result = await axios({
				method: 'POST',
				url,
				headers: {'content-type': 'multipart/form-data'},
				data: {steamID: this.steamID.getSteamID64(), ...params}
			});
			if (!result.headers || !result.headers['set-cookie'] || result.headers['set-cookie'].length == 0) {
				return reject(new Error('No Set-Cookie header in result'));
			}

			if (!result.headers['set-cookie'].some(c => c.startsWith('steamLoginSecure='))) {
				return reject(new Error('No steamLoginSecure cookie in result'));
			}

			resolve(result.headers['set-cookie'].map(c => c.split(';')[0].trim()));
		}));

		return await promiseAny(transfers);
	}
}

/**
 * @param {Promise[]} promises
 * @returns {Promise}
 */
function promiseAny(promises): Promise<any> {
	// for node <15 compat
	return new Promise((resolve, reject) => {
		let pendingPromises = promises.length;
		let rejections = [];
		promises.forEach((promise) => {
			promise.then((result) => {
				pendingPromises--;
				resolve(result);
			}).catch((err) => {
				pendingPromises--;
				rejections.push(err);

				if (pendingPromises == 0) {
					reject(rejections[0]);
				}
			})
		});
	});
}
