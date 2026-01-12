import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  Categories,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, Platform2NConfig } from './settings';
import { Intercom2NAccessory } from './accessory';

/**
 * 2N Intercom Platform
 * Manages 2N intercom accessories and handles Homebridge lifecycle.
 */
export class Intercom2NPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly config: Platform2NConfig;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = config as Platform2NConfig;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('[Platform] ========================================');
    this.log.info('[Platform] 2N Intercom Homebridge Plugin');
    this.log.info('[Platform] ========================================');
    this.log.info('[Platform] Initializing platform: %s', this.config.name);
    this.log.info('[Platform] Configuration:');
    this.log.info('[Platform]   - Host: %s', this.config.host || '(not set)');
    this.log.info('[Platform]   - Port: %d', this.config.port || 80);
    this.log.info('[Platform]   - HTTPS: %s', this.config.useHttps ? 'yes' : 'no');
    this.log.info('[Platform]   - Username: %s', this.config.username ? '***' : '(not set)');
    this.log.info('[Platform]   - Switch ID: %d', this.config.switchId || 1);

    // Validate configuration
    if (!this.config.host) {
      this.log.error('[Platform] ERROR: No host configured!');
      this.log.error('[Platform] Please set the IP address of your 2N device in the config.');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.error('[Platform] ERROR: Username and password are required!');
      this.log.error('[Platform] Please configure HTTP API credentials for your 2N device.');
      return;
    }

    // When Homebridge finishes loading, discover devices
    this.api.on('didFinishLaunching', () => {
      this.log.info('[Platform] Homebridge finished launching, discovering devices...');
      this.discoverDevices();
    });
  }

  /**
   * Called when Homebridge restores cached accessories from disk
   * For external/unbridged accessories, we need to unregister old cached ones
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('[Platform] Loading cached accessory: %s (UUID: %s)', accessory.displayName, accessory.UUID);
    this.accessories.push(accessory);
  }

  /**
   * Discover and register 2N device as an EXTERNAL accessory
   * External accessories are required for video doorbells to work properly in HomeKit
   */
  private discoverDevices(): void {
    this.log.info('[Platform] Discovering 2N devices...');

    // Generate a unique ID based on the host
    const uuid = this.api.hap.uuid.generate(this.config.host);
    this.log.debug('[Platform] Generated UUID for host %s: %s', this.config.host, uuid);

    // Check if there's an old cached bridged accessory - we need to remove it
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    if (existingAccessory) {
      this.log.info('[Platform] Found old cached bridged accessory, removing it...');
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
      this.log.info('[Platform] Old bridged accessory removed');
    }

    // Create the accessory as an EXTERNAL accessory (unbridged)
    // This is required for video doorbells to show doorbell functionality in HomeKit
    this.log.info('[Platform] Creating EXTERNAL accessory: %s', this.config.name);

    const accessory = new this.api.platformAccessory(
      this.config.name || '2N Intercom',
      uuid,
      Categories.VIDEO_DOORBELL,
    );

    // Store context
    accessory.context.host = this.config.host;
    accessory.context.port = this.config.port;
    accessory.context.username = this.config.username;
    accessory.context.password = this.config.password;
    accessory.context.useHttps = this.config.useHttps;
    accessory.context.switchId = this.config.switchId;
    accessory.context.doorbellButton = this.config.doorbellButton;
    accessory.context.rtspUrl = this.config.rtspUrl;
    accessory.context.videoCodec = this.config.videoCodec;

    // Create the accessory handler
    this.log.info('[Platform] Creating accessory handler');
    new Intercom2NAccessory(this, accessory);

    // Publish as EXTERNAL accessory - this is the key!
    // External accessories show up separately in HomeKit and properly expose video doorbell
    this.log.info('[Platform] Publishing as EXTERNAL accessory (unbridged)');
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.log.info('[Platform] External accessory published successfully');
    this.log.info('[Platform] NOTE: You may need to add this accessory separately in Home app');

    this.log.info('[Platform] Device discovery complete');
  }
}
