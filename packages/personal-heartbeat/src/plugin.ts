import { Service, type Context } from '@deepseek-ai/cordis';
import { HeartbeatService, type BackgroundWake, type ForegroundWake, type HeartbeatServiceOptions } from './service.js';

export class PersonalHeartbeatService extends Service<HeartbeatService> {
  private instance?: HeartbeatService;
  private readonly options: HeartbeatServiceOptions;
  constructor(ctx: Context, heartbeat?: HeartbeatService, options: HeartbeatServiceOptions = {}) {
    super(ctx, 'personalHeartbeat'); this.instance = heartbeat; this.options = options;
  }
  get heartbeat(): HeartbeatService { return this.instance ??= new HeartbeatService(this.options); }
  wakeForeground = (input: ForegroundWake) => this.heartbeat.wakeForeground(input);
  wakeBackground = (input: BackgroundWake) => this.heartbeat.wakeBackground(input);
}

export interface PersonalHeartbeatPluginOptions extends HeartbeatServiceOptions { heartbeat?: HeartbeatService; }
export function createPersonalHeartbeatPlugin(heartbeat?: HeartbeatService) { return (ctx: Context) => { new PersonalHeartbeatService(ctx, heartbeat); }; }
export function apply(ctx: Context, options?: PersonalHeartbeatPluginOptions): void { new PersonalHeartbeatService(ctx, options?.heartbeat, options); }
