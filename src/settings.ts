/**
 * Platform name - used to register the plugin with Homebridge
 */
export const PLATFORM_NAME = '2NIPForce';

/**
 * Plugin name - must match the name in package.json
 */
export const PLUGIN_NAME = 'homebridge-2n-ip-force';

/**
 * Default HTTP port for 2N API
 */
export const DEFAULT_PORT = 80;

/**
 * Default switch ID for door lock
 */
export const DEFAULT_SWITCH_ID = 1;

/**
 * Polling interval for events (ms)
 */
export const EVENT_POLL_INTERVAL = 1500;

/**
 * Polling interval for lock state (ms)
 */
export const STATE_POLL_INTERVAL = 10000;

/**
 * API endpoints for 2N HTTP API
 */
export const ApiEndpoints = {
  /** System information */
  SYSTEM_INFO: '/api/system/info',
  /** System status */
  SYSTEM_STATUS: '/api/system/status',
  /** Switch control */
  SWITCH_CTRL: '/api/switch/ctrl',
  /** Switch status */
  SWITCH_STATUS: '/api/switch/status',
  /** Switch capabilities */
  SWITCH_CAPS: '/api/switch/caps',
  /** Event subscription */
  LOG_SUBSCRIBE: '/api/log/subscribe',
  /** Event unsubscription */
  LOG_UNSUBSCRIBE: '/api/log/unsubscribe',
  /** Pull events */
  LOG_PULL: '/api/log/pull',
  /** Camera snapshot */
  CAMERA_SNAPSHOT: '/api/camera/snapshot',
  /** Camera capabilities */
  CAMERA_CAPS: '/api/camera/caps',
} as const;

/**
 * 2N API Event types
 */
export const EventTypes = {
  /** Key pressed on the intercom */
  KEY_PRESSED: 'KeyPressed',
  /** Key released on the intercom */
  KEY_RELEASED: 'KeyReleased',
  /** Motion detected */
  MOTION_DETECTED: 'MotionDetected',
  /** Card presented */
  CARD_ENTERED: 'CardEntered',
  /** Call started */
  CALL_STATE_CHANGED: 'CallStateChanged',
  /** Switch state changed */
  SWITCH_STATE_CHANGED: 'SwitchStateChanged',
  /** Input state changed */
  INPUT_CHANGED: 'InputChanged',
  /** Device state changed */
  DEVICE_STATE: 'DeviceState',
} as const;

/**
 * Switch actions
 */
export const SwitchAction = {
  ON: 'on',
  OFF: 'off',
  TRIGGER: 'trigger',
} as const;

/**
 * Plugin configuration interface
 */
export interface Platform2NConfig {
  platform: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  useHttps?: boolean;
  switchId?: number;
  doorbellButton?: string;
  rtspUrl?: string;
  videoCodec?: 'libx264' | 'h264_omx' | 'copy';
}

/**
 * 2N API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * System info response
 */
export interface SystemInfo {
  variant: string;
  serialNumber: string;
  hwVersion: string;
  swVersion: string;
  buildType: string;
  deviceName: string;
}

/**
 * Switch status response
 */
export interface SwitchStatus {
  switch: number;
  active: boolean;
  locked: boolean;
  held: boolean;
}

/**
 * Event from log pull
 */
export interface LogEvent {
  id: number;
  utcTime: number;
  upTime: number;
  event: string;
  params: Record<string, string | number | boolean>;
}

/**
 * Event subscription response
 */
export interface SubscriptionResponse {
  id: string;
}
