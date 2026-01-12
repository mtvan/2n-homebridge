import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import {
  DEFAULT_PORT,
  ApiEndpoints,
  ApiResponse,
  SystemInfo,
  SwitchStatus,
  LogEvent,
  SubscriptionResponse,
  SwitchAction,
} from './settings';

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/**
 * HTTP API client for communicating with 2N IP intercoms.
 */
export class Api2NClient extends EventEmitter {
  private host: string;
  private port: number;
  private username: string;
  private password: string;
  private useHttps: boolean;
  private log: Logger;
  private subscriptionId: string | null = null;
  private httpsAgent: https.Agent | null = null;
  private nonceCount: number = 0;
  private lastDigestChallenge: DigestChallenge | null = null;

  constructor(
    host: string,
    port: number = DEFAULT_PORT,
    username: string,
    password: string,
    useHttps: boolean = false,
    log: Logger,
  ) {
    super();
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.useHttps = useHttps;
    this.log = log;

    // Create an HTTPS agent that accepts self-signed certificates
    if (useHttps) {
      this.httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });
    }

    this.log.info('[Api2NClient] Initialized for %s://%s:%d', useHttps ? 'https' : 'http', host, port);
  }

  /**
   * Parse WWW-Authenticate header for Digest auth
   */
  private parseDigestChallenge(header: string): DigestChallenge | null {
    if (!header.toLowerCase().startsWith('digest ')) {
      return null;
    }

    const challenge: Partial<DigestChallenge> = {};
    const params = header.substring(7);

    // Parse key="value" pairs
    const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
    let match;
    while ((match = regex.exec(params)) !== null) {
      const key = match[1].toLowerCase();
      const value = match[2] || match[3];
      if (key === 'realm') {
        challenge.realm = value;
      } else if (key === 'nonce') {
        challenge.nonce = value;
      } else if (key === 'qop') {
        challenge.qop = value;
      } else if (key === 'opaque') {
        challenge.opaque = value;
      } else if (key === 'algorithm') {
        challenge.algorithm = value;
      }
    }

    if (challenge.realm && challenge.nonce) {
      return challenge as DigestChallenge;
    }
    return null;
  }

  /**
   * Generate Digest Authorization header
   */
  private generateDigestAuth(method: string, uri: string, challenge: DigestChallenge): string {
    const algorithm = challenge.algorithm || 'MD5';
    this.nonceCount++;
    const nc = this.nonceCount.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');

    // HA1 = MD5(username:realm:password)
    const ha1 = crypto.createHash('md5')
      .update(`${this.username}:${challenge.realm}:${this.password}`)
      .digest('hex');

    // HA2 = MD5(method:uri)
    const ha2 = crypto.createHash('md5')
      .update(`${method}:${uri}`)
      .digest('hex');

    let response: string;
    if (challenge.qop) {
      // response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
      response = crypto.createHash('md5')
        .update(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)
        .digest('hex');
    } else {
      // response = MD5(HA1:nonce:HA2)
      response = crypto.createHash('md5')
        .update(`${ha1}:${challenge.nonce}:${ha2}`)
        .digest('hex');
    }

    let authHeader = `Digest username="${this.username}", realm="${challenge.realm}", ` +
      `nonce="${challenge.nonce}", uri="${uri}", response="${response}"`;

    if (challenge.qop) {
      authHeader += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    }
    if (challenge.opaque) {
      authHeader += `, opaque="${challenge.opaque}"`;
    }
    if (algorithm !== 'MD5') {
      authHeader += `, algorithm=${algorithm}`;
    }

    return authHeader;
  }

  /**
   * Make a single HTTP request
   */
  private makeRequest(
    options: http.RequestOptions,
    isJsonResponse: boolean = true,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; data: string | Buffer }> {
    return new Promise((resolve, reject) => {
      const requestOptions: http.RequestOptions | https.RequestOptions = this.useHttps
        ? { ...options, agent: this.httpsAgent! }
        : options;
      const client = this.useHttps ? https : http;

      const req = client.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            data: isJsonResponse ? buffer.toString() : buffer,
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Make an HTTP request to the 2N API with Digest auth support
   */
  private async request<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(endpoint, `${this.useHttps ? 'https' : 'http'}://${this.host}:${this.port}`);

    // Add query parameters
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });

    const path = url.pathname + url.search;

    // Try with cached digest challenge first, or basic auth
    let authHeader: string;
    if (this.lastDigestChallenge) {
      authHeader = this.generateDigestAuth('GET', path, this.lastDigestChallenge);
    } else {
      authHeader = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    }

    const options: http.RequestOptions = {
      hostname: this.host,
      port: this.port,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
      },
    };

    this.log.debug('[Api2NClient] Request: %s %s', options.method, options.path);

    try {
      let response = await this.makeRequest(options);

      // If we get 401 with WWW-Authenticate, try Digest auth
      if (response.statusCode === 401 && response.headers['www-authenticate']) {
        const wwwAuth = response.headers['www-authenticate'];
        this.log.debug('[Api2NClient] Got 401, WWW-Authenticate: %s', wwwAuth);

        const challenge = this.parseDigestChallenge(wwwAuth as string);
        if (challenge) {
          this.log.debug('[Api2NClient] Using Digest authentication');
          this.lastDigestChallenge = challenge;
          this.nonceCount = 0;

          // Retry with Digest auth
          options.headers = {
            ...options.headers,
            'Authorization': this.generateDigestAuth('GET', path, challenge),
          };
          response = await this.makeRequest(options);
        } else {
          throw new Error('Authentication failed - unsupported auth method');
        }
      }

      this.log.info('[Api2NClient] Response status: %d', response.statusCode);
      this.log.debug('[Api2NClient] Response body: %s', (response.data as string).substring(0, 500));

      if (response.statusCode === 401) {
        throw new Error('Authentication failed - check username/password');
      }

      if (response.statusCode !== 200) {
        throw new Error(`HTTP error: ${response.statusCode} - ${(response.data as string).substring(0, 200)}`);
      }

      try {
        const apiResponse = JSON.parse(response.data as string) as ApiResponse<T>;
        if (!apiResponse.success) {
          this.log.warn('[Api2NClient] API returned success=false: %j', apiResponse);
        }
        return apiResponse;
      } catch (err) {
        this.log.error('[Api2NClient] Failed to parse JSON: %s', (response.data as string).substring(0, 500));
        throw new Error(`Failed to parse response: ${err}`);
      }
    } catch (err) {
      this.log.error('[Api2NClient] Request error: %s', (err as Error).message);
      throw err;
    }
  }

  /**
   * Get system information
   */
  async getSystemInfo(): Promise<SystemInfo> {
    this.log.debug('[Api2NClient] Getting system info...');

    const response = await this.request<SystemInfo>(ApiEndpoints.SYSTEM_INFO);

    if (!response.success || !response.result) {
      throw new Error(`Failed to get system info: ${response.error?.message || 'Unknown error'}`);
    }

    this.log.info('[Api2NClient] Device: %s (S/N: %s, FW: %s)',
      response.result.deviceName || response.result.variant,
      response.result.serialNumber,
      response.result.swVersion);

    return response.result;
  }

  /**
   * Get switch/lock status
   */
  async getSwitchStatus(switchId: number): Promise<SwitchStatus> {
    this.log.debug('[Api2NClient] Getting switch %d status...', switchId);

    const response = await this.request<{ switches: SwitchStatus[] }>(
      ApiEndpoints.SWITCH_STATUS,
      { switch: switchId },
    );

    if (!response.success || !response.result) {
      throw new Error(`Failed to get switch status: ${response.error?.message || JSON.stringify(response)}`);
    }

    const switchStatus = response.result.switches?.find(s => s.switch === switchId);
    if (!switchStatus) {
      throw new Error(`Switch ${switchId} not found`);
    }

    this.log.debug('[Api2NClient] Switch %d: active=%s, locked=%s',
      switchId, switchStatus.active, switchStatus.locked);

    return switchStatus;
  }

  /**
   * Control switch/lock
   */
  async setSwitchState(switchId: number, action: typeof SwitchAction[keyof typeof SwitchAction]): Promise<void> {
    this.log.info('[Api2NClient] Setting switch %d to: %s', switchId, action);

    const response = await this.request<{ result: boolean }>(
      ApiEndpoints.SWITCH_CTRL,
      { switch: switchId, action },
    );

    if (!response.success) {
      throw new Error(`Failed to control switch: ${response.error?.message || 'Unknown error'}`);
    }

    this.log.info('[Api2NClient] Switch %d set to %s successfully', switchId, action);
  }

  /**
   * Unlock the door (trigger switch momentarily)
   */
  async unlockDoor(switchId: number): Promise<void> {
    return this.setSwitchState(switchId, SwitchAction.TRIGGER);
  }

  /**
   * Subscribe to events
   */
  async subscribeToEvents(): Promise<string> {
    this.log.info('[Api2NClient] Subscribing to events...');

    const response = await this.request<SubscriptionResponse>(
      ApiEndpoints.LOG_SUBSCRIBE,
      {
        include: 'KeyPressed,KeyReleased,SwitchStateChanged,MotionDetected',
      },
    );

    if (!response.success || !response.result) {
      throw new Error(`Failed to subscribe to events: ${response.error?.message || JSON.stringify(response)}`);
    }

    this.subscriptionId = response.result.id;
    this.log.info('[Api2NClient] Subscribed to events, subscription ID: %s', this.subscriptionId);

    return this.subscriptionId;
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribeFromEvents(): Promise<void> {
    if (!this.subscriptionId) {
      return;
    }

    this.log.info('[Api2NClient] Unsubscribing from events...');

    try {
      await this.request(ApiEndpoints.LOG_UNSUBSCRIBE, { id: this.subscriptionId });
      this.log.info('[Api2NClient] Unsubscribed from events');
    } catch (err) {
      this.log.warn('[Api2NClient] Failed to unsubscribe: %s', (err as Error).message);
    } finally {
      this.subscriptionId = null;
    }
  }

  /**
   * Pull events from subscription
   */
  async pullEvents(timeout: number = 5): Promise<LogEvent[]> {
    if (!this.subscriptionId) {
      throw new Error('Not subscribed to events');
    }

    this.log.debug('[Api2NClient] Pulling events (timeout: %ds)...', timeout);

    const response = await this.request<{ events: LogEvent[] }>(
      ApiEndpoints.LOG_PULL,
      { id: this.subscriptionId, timeout },
    );

    if (!response.success || !response.result) {
      // Subscription may have expired
      if (response.error?.code === 12) {
        this.log.warn('[Api2NClient] Subscription expired, re-subscribing...');
        this.subscriptionId = null;
        await this.subscribeToEvents();
        return [];
      }
      throw new Error(`Failed to pull events: ${response.error?.message || 'Unknown error'}`);
    }

    const events = response.result.events || [];
    if (events.length > 0) {
      this.log.debug('[Api2NClient] Received %d event(s)', events.length);
    }

    return events;
  }

  /**
   * Get camera snapshot as buffer
   */
  async getSnapshot(width: number = 640, height: number = 480): Promise<Buffer> {
    this.log.debug('[Api2NClient] Getting camera snapshot (%dx%d)...', width, height);

    const url = new URL(ApiEndpoints.CAMERA_SNAPSHOT, `${this.useHttps ? 'https' : 'http'}://${this.host}:${this.port}`);
    url.searchParams.append('width', String(width));
    url.searchParams.append('height', String(height));

    const path = url.pathname + url.search;

    // Use cached digest challenge or basic auth
    let authHeader: string;
    if (this.lastDigestChallenge) {
      authHeader = this.generateDigestAuth('GET', path, this.lastDigestChallenge);
    } else {
      authHeader = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    }

    const options: http.RequestOptions = {
      hostname: this.host,
      port: this.port,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': authHeader,
      },
    };

    try {
      let response = await this.makeRequest(options, false);

      // If we get 401 with WWW-Authenticate, try Digest auth
      if (response.statusCode === 401 && response.headers['www-authenticate']) {
        const challenge = this.parseDigestChallenge(response.headers['www-authenticate'] as string);
        if (challenge) {
          this.lastDigestChallenge = challenge;
          this.nonceCount = 0;

          options.headers = {
            ...options.headers,
            'Authorization': this.generateDigestAuth('GET', path, challenge),
          };
          response = await this.makeRequest(options, false);
        }
      }

      if (response.statusCode !== 200) {
        throw new Error(`Failed to get snapshot: HTTP ${response.statusCode}`);
      }

      const buffer = response.data as Buffer;
      this.log.debug('[Api2NClient] Received snapshot: %d bytes', buffer.length);
      return buffer;
    } catch (err) {
      this.log.error('[Api2NClient] Snapshot error: %s', (err as Error).message);
      throw err;
    }
  }

  /**
   * Build RTSP URL for camera stream
   */
  getRtspUrl(): string {
    // 2N intercoms typically use this RTSP path
    const protocol = 'rtsp';
    const credentials = `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}`;
    return `${protocol}://${credentials}@${this.host}/mjpeg_stream`;
  }

  /**
   * Get the snapshot URL for camera
   */
  getSnapshotUrl(width: number = 640, height: number = 480): string {
    const protocol = this.useHttps ? 'https' : 'http';
    const credentials = `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}`;
    return `${protocol}://${credentials}@${this.host}:${this.port}${ApiEndpoints.CAMERA_SNAPSHOT}?width=${width}&height=${height}`;
  }

  /**
   * Check if currently subscribed to events
   */
  isSubscribed(): boolean {
    return this.subscriptionId !== null;
  }

  /**
   * Get current subscription ID
   */
  getSubscriptionId(): string | null {
    return this.subscriptionId;
  }
}
