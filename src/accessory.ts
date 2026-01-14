import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  DoorbellController,
} from 'homebridge';

import { Intercom2NPlatform } from './platform';
import { Api2NClient } from './api2nClient';
import { CameraSource } from './cameraSource';
import {
  DEFAULT_PORT,
  DEFAULT_HTTPS_PORT,
  DEFAULT_SWITCH_ID,
  EVENT_POLL_INTERVAL,
  STATE_POLL_INTERVAL,
  EventTypes,
  LogEvent,
} from './settings';

/**
 * 2N Intercom Accessory
 * Exposes the 2N intercom as a Doorbell with Lock in HomeKit.
 */
export class Intercom2NAccessory {
  private doorbellController?: DoorbellController;
  private lockService: Service;
  private client: Api2NClient;
  private cameraSource?: CameraSource;

  // State
  private lockCurrentState: number;
  private lockTargetState: number;
  private eventPollInterval: NodeJS.Timeout | null = null;
  private statePollInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: Intercom2NPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const context = this.accessory.context;

    // Initialize lock states (default to locked)
    this.lockCurrentState = this.platform.Characteristic.LockCurrentState.SECURED;
    this.lockTargetState = this.platform.Characteristic.LockTargetState.SECURED;

    // Determine the correct port - use HTTPS port (443) by default when useHttps is enabled
    const useHttps = context.useHttps || false;
    const port = context.port || (useHttps ? DEFAULT_HTTPS_PORT : DEFAULT_PORT);

    this.platform.log.info('[Accessory] Initializing 2N Intercom accessory');
    this.platform.log.info('[Accessory] Host: %s, Port: %d, HTTPS: %s', context.host, port, useHttps);

    // Initialize the API client
    this.client = new Api2NClient(
      context.host,
      port,
      context.username,
      context.password,
      useHttps,
      this.platform.log,
    );

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, '2N')
      .setCharacteristic(this.platform.Characteristic.Model, 'IP Intercom')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, context.host);

    // Get or create the Lock Mechanism service with subtype
    this.lockService = this.accessory.getService(this.platform.Service.LockMechanism)
      || this.accessory.addService(this.platform.Service.LockMechanism, 'Door Lock', 'lock');

    this.lockService.setCharacteristic(
      this.platform.Characteristic.Name,
      'Door Lock',
    );

    this.platform.log.info('[Accessory] Lock service created');

    // Set up DoorbellController (handles doorbell service + camera streaming)
    this.setupDoorbellController();

    // Register handlers for Lock characteristics
    this.lockService.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.lockService.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    // Initialize connection and start polling
    this.initialize();
  }

  /**
   * Set up DoorbellController with camera streaming
   * DoorbellController handles the doorbell service automatically and provides ringDoorbell() method
   */
  private setupDoorbellController(): void {
    const context = this.accessory.context;

    try {
      this.platform.log.info('[Accessory] Setting up DoorbellController...');

      // Determine RTSP URL
      const rtspUrl = context.rtspUrl || this.client.getRtspUrl();
      this.platform.log.info('[Accessory] RTSP URL: %s', rtspUrl.replace(/:[^:@]+@/, ':***@'));

      // Create camera source (streaming delegate)
      this.cameraSource = new CameraSource(
        this.platform,
        this.accessory,
        this.client,
        rtspUrl,
        context.videoCodec || 'libx264',
      );

      // Configure the DoorbellController (extends CameraController with doorbell functionality)
      this.doorbellController = new this.platform.api.hap.DoorbellController({
        cameraStreamCount: 2,
        delegate: this.cameraSource,
        streamingOptions: {
          supportedCryptoSuites: [
            this.platform.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
          ],
          video: {
            resolutions: [
              [1920, 1080, 30],
              [1280, 720, 30],
              [640, 480, 30],
              [640, 360, 30],
              [480, 360, 30],
              [480, 270, 30],
              [320, 240, 30],
              [320, 240, 15],
              [320, 180, 30],
            ],
            codec: {
              profiles: [
                this.platform.api.hap.H264Profile.BASELINE,
                this.platform.api.hap.H264Profile.MAIN,
                this.platform.api.hap.H264Profile.HIGH,
              ],
              levels: [
                this.platform.api.hap.H264Level.LEVEL3_1,
                this.platform.api.hap.H264Level.LEVEL3_2,
                this.platform.api.hap.H264Level.LEVEL4_0,
              ],
            },
          },
          audio: {
            twoWayAudio: false,
            codecs: [
              {
                type: this.platform.api.hap.AudioStreamingCodecType.AAC_ELD,
                samplerate: this.platform.api.hap.AudioStreamingSamplerate.KHZ_16,
              },
            ],
          },
        },
      });

      this.accessory.configureController(this.doorbellController);
      this.platform.log.info('[Accessory] DoorbellController configured successfully');

      // Link the lock service to the doorbell service created by the controller
      // The DoorbellController creates a Doorbell service on the accessory
      const doorbellService = this.accessory.getService(this.platform.Service.Doorbell);
      if (doorbellService) {
        doorbellService.addLinkedService(this.lockService);
        this.platform.log.info('[Accessory] Lock service linked to doorbell');
      }
    } catch (err) {
      this.platform.log.error('[Accessory] Failed to set up DoorbellController: %s', (err as Error).message);
    }
  }

  /**
   * Initialize connection and start polling
   */
  private async initialize(): Promise<void> {
    this.platform.log.info('[Accessory] Initializing connection to 2N device...');

    try {
      // Test connection by getting system info
      const systemInfo = await this.client.getSystemInfo();

      // Update accessory information with actual device info
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.Model, systemInfo.variant || 'IP Intercom')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, systemInfo.serialNumber)
        .setCharacteristic(this.platform.Characteristic.FirmwareRevision, systemInfo.swVersion);

      this.platform.log.info('[Accessory] Connected to %s (S/N: %s)',
        systemInfo.deviceName || systemInfo.variant,
        systemInfo.serialNumber);

      // Subscribe to events and start polling
      await this.startEventPolling();
      this.startStatePolling();
    } catch (err) {
      this.platform.log.error('[Accessory] Failed to initialize: %s', (err as Error).message);
      this.platform.log.error('[Accessory] Will retry in 30 seconds...');

      // Retry initialization after delay
      setTimeout(() => this.initialize(), 30000);
    }
  }

  /**
   * Start polling for events (doorbell, etc.)
   */
  private async startEventPolling(): Promise<void> {
    if (this.eventPollInterval) {
      return;
    }

    this.platform.log.info('[Accessory] Starting event polling...');

    try {
      // Subscribe to events
      await this.client.subscribeToEvents();

      // Start polling interval
      this.eventPollInterval = setInterval(async () => {
        await this.pollEvents();
      }, EVENT_POLL_INTERVAL);

      this.platform.log.info('[Accessory] Event polling started (every %dms)', EVENT_POLL_INTERVAL);
    } catch (err) {
      this.platform.log.error('[Accessory] Failed to start event polling: %s', (err as Error).message);
    }
  }

  /**
   * Poll for events
   */
  private async pollEvents(): Promise<void> {
    try {
      const events = await this.client.pullEvents(1);

      for (const event of events) {
        this.handleEvent(event);
      }
    } catch (err) {
      this.platform.log.warn('[Accessory] Event poll error: %s', (err as Error).message);

      // Try to re-subscribe if subscription was lost
      if (!this.client.isSubscribed()) {
        try {
          await this.client.subscribeToEvents();
        } catch (subErr) {
          this.platform.log.error('[Accessory] Failed to re-subscribe: %s', (subErr as Error).message);
        }
      }
    }
  }

  /**
   * Handle an event from the 2N device
   */
  private handleEvent(event: LogEvent): void {
    // Log ALL events at info level for diagnosis
    this.platform.log.info('[Accessory] Event received: %s - %j', event.event, event.params);

    const doorbellButton = this.accessory.context.doorbellButton || '1';

    switch (event.event) {
      case EventTypes.KEY_PRESSED:
        // Check if it's the doorbell button
        if (String(event.params.key) === doorbellButton) {
          this.platform.log.info('[Accessory] Doorbell button pressed!');
          this.triggerDoorbell();
        } else {
          this.platform.log.debug('[Accessory] Key %s pressed (not doorbell button)', event.params.key);
        }
        break;

      case EventTypes.SWITCH_STATE_CHANGED:
        this.platform.log.info('[Accessory] Switch state changed: %j', event.params);
        // Update lock state based on switch event
        if (event.params.state === true || event.params.state === 'true') {
          this.lockCurrentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
        } else {
          this.lockCurrentState = this.platform.Characteristic.LockCurrentState.SECURED;
        }
        this.lockService.updateCharacteristic(
          this.platform.Characteristic.LockCurrentState,
          this.lockCurrentState,
        );
        break;

      case EventTypes.MOTION_DETECTED:
        this.platform.log.info('[Accessory] Motion detected');
        // Could trigger doorbell or motion sensor here
        break;

      case EventTypes.INPUT_CHANGED:
        // Some 2N devices use input changes for doorbell button
        this.platform.log.info('[Accessory] Input changed: port=%s, state=%s',
          event.params.port, event.params.state);
        // Trigger doorbell if input goes active (state true or 1)
        if (event.params.state === true || event.params.state === 'true' ||
            event.params.state === 1 || event.params.state === '1') {
          this.platform.log.info('[Accessory] Input triggered doorbell!');
          this.triggerDoorbell();
        }
        break;

      case EventTypes.CALL_STATE_CHANGED:
        // Trigger doorbell when call is initiated from the intercom
        this.platform.log.info('[Accessory] Call state changed: state=%s, direction=%s',
          event.params.state, event.params.direction);
        if (event.params.state === 'ringing' || event.params.state === 'connecting' ||
            event.params.direction === 'outgoing') {
          this.platform.log.info('[Accessory] Call initiated - triggering doorbell!');
          this.triggerDoorbell();
        }
        break;

      default:
        this.platform.log.info('[Accessory] Unhandled event type: %s', event.event);
    }
  }

  /**
   * Trigger a doorbell press event in HomeKit
   */
  private triggerDoorbell(): void {
    this.platform.log.info('[Accessory] Triggering doorbell notification');

    // Get the Doorbell service and update characteristic directly
    // This is more reliable than using doorbellController.ringDoorbell()
    const doorbellService = this.accessory.getService(this.platform.Service.Doorbell);

    if (doorbellService) {
      doorbellService.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );
      this.platform.log.info('[Accessory] Doorbell SINGLE_PRESS sent to HomeKit');
    } else {
      this.platform.log.warn('[Accessory] Doorbell service not found');
    }

    // Also call ringDoorbell() as backup
    if (this.doorbellController) {
      this.doorbellController.ringDoorbell();
      this.platform.log.info('[Accessory] DoorbellController.ringDoorbell() called');
    }
  }

  /**
   * Start polling for lock state
   */
  private startStatePolling(): void {
    if (this.statePollInterval) {
      return;
    }

    this.platform.log.info('[Accessory] Starting state polling (every %ds)', STATE_POLL_INTERVAL / 1000);

    this.statePollInterval = setInterval(async () => {
      await this.pollLockState();
    }, STATE_POLL_INTERVAL);

    // Also do an immediate poll
    this.pollLockState();
  }

  /**
   * Poll the current lock state
   */
  private async pollLockState(): Promise<void> {
    const switchId = this.accessory.context.switchId || DEFAULT_SWITCH_ID;

    try {
      const status = await this.client.getSwitchStatus(switchId);

      // Update lock state based on switch active state
      // active = unlocked, !active = locked
      const newState = status.active
        ? this.platform.Characteristic.LockCurrentState.UNSECURED
        : this.platform.Characteristic.LockCurrentState.SECURED;

      if (newState !== this.lockCurrentState) {
        this.platform.log.info('[Accessory] Lock state changed: %s',
          newState === this.platform.Characteristic.LockCurrentState.SECURED ? 'LOCKED' : 'UNLOCKED');
        this.lockCurrentState = newState;
        this.lockService.updateCharacteristic(
          this.platform.Characteristic.LockCurrentState,
          this.lockCurrentState,
        );
      }
    } catch (err) {
      this.platform.log.warn('[Accessory] Failed to poll lock state: %s', (err as Error).message);
    }
  }

  /**
   * Handle GET requests for lock current state
   */
  private getLockCurrentState(): CharacteristicValue {
    this.platform.log.debug('[Accessory] GET LockCurrentState -> %s',
      this.lockCurrentState === this.platform.Characteristic.LockCurrentState.SECURED ? 'LOCKED' : 'UNLOCKED');
    return this.lockCurrentState;
  }

  /**
   * Handle GET requests for lock target state
   */
  private getLockTargetState(): CharacteristicValue {
    this.platform.log.debug('[Accessory] GET LockTargetState -> %s',
      this.lockTargetState === this.platform.Characteristic.LockTargetState.SECURED ? 'LOCKED' : 'UNLOCKED');
    return this.lockTargetState;
  }

  /**
   * Handle SET requests for lock target state
   */
  private async setLockTargetState(value: CharacteristicValue): Promise<void> {
    const targetState = value as number;
    const isUnlock = targetState === this.platform.Characteristic.LockTargetState.UNSECURED;

    this.platform.log.info('[Accessory] SET LockTargetState -> %s', isUnlock ? 'UNLOCK' : 'LOCK');

    this.lockTargetState = targetState;

    if (isUnlock) {
      try {
        const switchId = this.accessory.context.switchId || DEFAULT_SWITCH_ID;

        // Trigger the door unlock
        await this.client.unlockDoor(switchId);

        this.platform.log.info('[Accessory] Door unlocked successfully');

        // Update current state to unlocked
        this.lockCurrentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
        this.lockService.updateCharacteristic(
          this.platform.Characteristic.LockCurrentState,
          this.lockCurrentState,
        );

        // After a delay, set back to locked (door auto-locks)
        setTimeout(() => {
          this.platform.log.info('[Accessory] Door auto-locking...');
          this.lockCurrentState = this.platform.Characteristic.LockCurrentState.SECURED;
          this.lockTargetState = this.platform.Characteristic.LockTargetState.SECURED;
          this.lockService.updateCharacteristic(
            this.platform.Characteristic.LockCurrentState,
            this.lockCurrentState,
          );
          this.lockService.updateCharacteristic(
            this.platform.Characteristic.LockTargetState,
            this.lockTargetState,
          );
        }, 5000); // Auto-lock after 5 seconds
      } catch (err) {
        this.platform.log.error('[Accessory] Failed to unlock door: %s', (err as Error).message);

        // Reset to locked state on error
        this.lockTargetState = this.platform.Characteristic.LockTargetState.SECURED;
        this.lockService.updateCharacteristic(
          this.platform.Characteristic.LockTargetState,
          this.lockTargetState,
        );

        throw err;
      }
    } else {
      // Lock command - just update state (door is already locked or will auto-lock)
      this.lockCurrentState = this.platform.Characteristic.LockCurrentState.SECURED;
      this.lockService.updateCharacteristic(
        this.platform.Characteristic.LockCurrentState,
        this.lockCurrentState,
      );
    }
  }

  /**
   * Clean up when accessory is removed
   */
  destroy(): void {
    this.platform.log.info('[Accessory] Destroying accessory...');

    if (this.eventPollInterval) {
      clearInterval(this.eventPollInterval);
      this.eventPollInterval = null;
    }

    if (this.statePollInterval) {
      clearInterval(this.statePollInterval);
      this.statePollInterval = null;
    }

    // Unsubscribe from events
    this.client.unsubscribeFromEvents().catch(() => {
      // Ignore errors during cleanup
    });
  }
}
