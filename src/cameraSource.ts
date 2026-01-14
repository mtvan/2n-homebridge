import {
  CameraStreamingDelegate,
  HAP,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  StreamSessionIdentifier,
  VideoInfo,
  AudioInfo,
} from 'homebridge';
import { spawn, ChildProcess } from 'child_process';
import { Socket } from 'dgram';

import { Intercom2NPlatform } from './platform';
import { Api2NClient } from './api2nClient';

interface SessionInfo {
  address: string;
  videoPort: number;
  videoCryptoSuite: number;
  videoSRTP: Buffer;
  videoSSRC: number;

  audioPort: number;
  audioCryptoSuite: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ActiveSession {
  videoProcess?: ChildProcess;
  audioProcess?: ChildProcess;
  videoSocket?: Socket;
  audioSocket?: Socket;
  videoReturnSocket?: Socket;
  audioReturnSocket?: Socket;
}

/**
 * Camera streaming delegate for 2N intercom camera
 */
export class CameraSource implements CameraStreamingDelegate {
  private readonly hap: HAP;
  private readonly platform: Intercom2NPlatform;
  private readonly client: Api2NClient;
  private readonly rtspUrl: string;
  private readonly videoCodec: string;

  private pendingSessions: Map<StreamSessionIdentifier, SessionInfo> = new Map();
  private activeSessions: Map<StreamSessionIdentifier, ActiveSession> = new Map();

  constructor(
    platform: Intercom2NPlatform,
    _accessory: PlatformAccessory,
    client: Api2NClient,
    rtspUrl: string,
    videoCodec: string,
  ) {
    this.platform = platform;
    this.hap = platform.api.hap;
    this.client = client;
    this.rtspUrl = rtspUrl;
    this.videoCodec = videoCodec;

    this.platform.log.info('[Camera] Initialized with RTSP URL: %s', rtspUrl.replace(/:[^:@]+@/, ':***@'));
    this.platform.log.info('[Camera] Video codec: %s', videoCodec);
  }

  /**
   * Handle snapshot requests
   */
  async handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): Promise<void> {
    this.platform.log.info('[Camera] Snapshot requested: %dx%d', request.width, request.height);

    try {
      const snapshot = await this.client.getSnapshot(request.width, request.height);
      this.platform.log.info('[Camera] Snapshot received: %d bytes', snapshot.length);
      callback(undefined, snapshot);
    } catch (err) {
      this.platform.log.error('[Camera] Snapshot error: %s', (err as Error).message);
      callback(err as Error);
    }
  }

  /**
   * Prepare stream
   */
  prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): void {
    this.platform.log.info('[Camera] Preparing stream for session %s', request.sessionID);

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),

      audioPort: request.audio?.port || 0,
      audioCryptoSuite: request.audio?.srtpCryptoSuite || 0,
      audioSRTP: request.audio ? Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]) : Buffer.alloc(0),
      audioSSRC: this.hap.CameraController.generateSynchronisationSource(),
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);

    const response: PrepareStreamResponse = {
      video: {
        port: request.video.port,
        ssrc: sessionInfo.videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    };

    if (request.audio) {
      response.audio = {
        port: request.audio.port,
        ssrc: sessionInfo.audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      };
    }

    this.platform.log.debug('[Camera] Stream prepared - target: %s:%d', sessionInfo.address, sessionInfo.videoPort);
    callback(undefined, response);
  }

  /**
   * Handle stream request
   */
  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ): void {
    const sessionId = request.sessionID;

    switch (request.type) {
      case StreamRequestTypes.START:
        this.platform.log.info('[Camera] Starting stream for session %s', sessionId);
        this.startStream(sessionId, request.video, request.audio);
        callback();
        break;

      case StreamRequestTypes.RECONFIGURE:
        this.platform.log.info('[Camera] Reconfiguring stream for session %s', sessionId);
        // For simplicity, we don't reconfigure - just acknowledge
        callback();
        break;

      case StreamRequestTypes.STOP:
        this.platform.log.info('[Camera] Stopping stream for session %s', sessionId);
        this.stopStream(sessionId);
        callback();
        break;
    }
  }

  /**
   * Start streaming
   */
  private startStream(
    sessionId: StreamSessionIdentifier,
    videoRequest: VideoInfo,
    audioRequest?: AudioInfo,
  ): void {
    const sessionInfo = this.pendingSessions.get(sessionId);
    if (!sessionInfo) {
      this.platform.log.error('[Camera] No session info for %s', sessionId);
      return;
    }

    this.pendingSessions.delete(sessionId);

    const width = videoRequest.width;
    const height = videoRequest.height;
    const fps = videoRequest.fps;
    const videoBitrate = videoRequest.max_bit_rate;

    this.platform.log.info('[Camera] Stream config: %dx%d @ %dfps, %dkbps', width, height, fps, videoBitrate);

    // Build ffmpeg command
    const ffmpegArgs = this.buildFfmpegArgs(
      sessionInfo,
      width,
      height,
      fps,
      videoBitrate,
      audioRequest,
    );

    this.platform.log.debug('[Camera] FFmpeg args: %s', ffmpegArgs.join(' '));

    // Spawn ffmpeg process - use full path for Homebridge compatibility
    const ffmpegPath = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
    this.platform.log.debug('[Camera] Using FFmpeg at: %s', ffmpegPath);
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      env: process.env,
    });

    const activeSession: ActiveSession = {
      videoProcess: ffmpegProcess,
    };

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      // Only log errors, not progress
      if (message.includes('error') || message.includes('Error')) {
        this.platform.log.error('[Camera] FFmpeg: %s', message.trim());
      } else {
        this.platform.log.debug('[Camera] FFmpeg: %s', message.substring(0, 200));
      }
    });

    ffmpegProcess.on('error', (err) => {
      this.platform.log.error('[Camera] FFmpeg error: %s', err.message);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      if (signal) {
        this.platform.log.info('[Camera] FFmpeg killed with signal %s', signal);
      } else if (code !== 0) {
        this.platform.log.error('[Camera] FFmpeg exited with code %d', code);
      } else {
        this.platform.log.info('[Camera] FFmpeg exited cleanly');
      }
    });

    this.activeSessions.set(sessionId, activeSession);
    this.platform.log.info('[Camera] Stream started for session %s', sessionId);
  }

  /**
   * Build ffmpeg arguments
   */
  private buildFfmpegArgs(
    sessionInfo: SessionInfo,
    width: number,
    height: number,
    fps: number,
    videoBitrate: number,
    _audioRequest?: AudioInfo,
  ): string[] {
    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'warning',

      // Low-latency input options - reduces startup time
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32000',
      '-analyzeduration', '1000000',

      // Input
      '-rtsp_transport', 'tcp',
      '-i', this.rtspUrl,

      // Video output
      '-an', // No audio for now
      '-vcodec', this.videoCodec,
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
    ];

    // Add video codec specific options
    if (this.videoCodec === 'libx264') {
      args.push(
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-level:v', '3.1',
      );
    }

    // Video bitrate and size - smaller buffer for faster startup
    args.push(
      '-b:v', `${videoBitrate}k`,
      '-bufsize', `${videoBitrate}k`,
      '-maxrate', `${videoBitrate}k`,
      '-g', String(fps * 2), // Keyframe every 2 seconds for faster seeking
      '-vf', `scale=${width}:${height}`,
    );

    // Output to RTP
    const videoPayloadType = 99;
    const srtpSuite = 'AES_CM_128_HMAC_SHA1_80';
    const srtpParams = sessionInfo.videoSRTP.toString('base64');

    args.push(
      '-payload_type', String(videoPayloadType),
      '-ssrc', String(sessionInfo.videoSSRC),
      '-f', 'rtp',
      '-srtp_out_suite', srtpSuite,
      '-srtp_out_params', srtpParams,
      `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=1316`,
    );

    return args;
  }

  /**
   * Stop streaming
   */
  private stopStream(sessionId: StreamSessionIdentifier): void {
    const activeSession = this.activeSessions.get(sessionId);

    if (activeSession) {
      if (activeSession.videoProcess) {
        activeSession.videoProcess.kill('SIGKILL');
      }
      if (activeSession.audioProcess) {
        activeSession.audioProcess.kill('SIGKILL');
      }
      if (activeSession.videoSocket) {
        activeSession.videoSocket.close();
      }
      if (activeSession.audioSocket) {
        activeSession.audioSocket.close();
      }

      this.activeSessions.delete(sessionId);
      this.platform.log.info('[Camera] Stream stopped for session %s', sessionId);
    }

    // Also clean up any pending session
    this.pendingSessions.delete(sessionId);
  }
}
