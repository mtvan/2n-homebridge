import * as http from 'http';
import * as https from 'https';
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
    this.log.info('[Api2NClient] Initialized for %s://%s:%d', useHttps ? 'https' : 'http', host, port);
  }

  /**
   * Make an HTTP request to the 2N API
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

    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

    const options: http.RequestOptions = {
      hostname: this.host,
      port: this.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    };

    this.log.debug('[Api2NClient] Request: %s %s', options.method, options.path);

    return new Promise((resolve, reject) => {
      // Use https with rejectUnauthorized: false for self-signed certs
      const requestOptions = this.useHttps
        ? { ...options, rejectUnauthorized: false }
        : options;
      const client = this.useHttps ? https : http;

      const req = client.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          this.log.info('[Api2NClient] Response status: %d', res.statusCode);
          this.log.info('[Api2NClient] Response body: %s', data.substring(0, 500));

          if (res.statusCode === 401) {
            reject(new Error('Authentication failed - check username/password'));
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP error: ${res.statusCode} - ${data.substring(0, 200)}`));
            return;
          }

          try {
            const response = JSON.parse(data) as ApiResponse<T>;
            if (!response.success) {
              this.log.warn('[Api2NClient] API returned success=false: %j', response);
            }
            resolve(response);
          } catch (err) {
            this.log.error('[Api2NClient] Failed to parse JSON: %s', data.substring(0, 500));
            reject(new Error(`Failed to parse response: ${err}`));
          }
        });
      });

      req.on('error', (err) => {
        this.log.error('[Api2NClient] Request error: %s', err.message);
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

    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

    const options: http.RequestOptions = {
      hostname: this.host,
      port: this.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    };

    return new Promise((resolve, reject) => {
      // Use https with rejectUnauthorized: false for self-signed certs
      const requestOptions = this.useHttps
        ? { ...options, rejectUnauthorized: false }
        : options;
      const client = this.useHttps ? https : http;

      const req = client.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to get snapshot: HTTP ${res.statusCode}`));
            return;
          }

          const buffer = Buffer.concat(chunks);
          this.log.debug('[Api2NClient] Received snapshot: %d bytes', buffer.length);
          resolve(buffer);
        });
      });

      req.on('error', (err) => {
        this.log.error('[Api2NClient] Snapshot error: %s', err.message);
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Snapshot request timeout'));
      });

      req.end();
    });
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
