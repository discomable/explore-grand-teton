const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
const deadZone = (v, dz) => Math.abs(v) <= dz ? 0 : Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);

export class DrivingInput {
  constructor({ steeringRamp = 5, steeringRelease = 7, gamepadDeadZone = .14 } = {}) {
    this.steeringRamp = steeringRamp;
    this.steeringRelease = steeringRelease;
    this.gamepadDeadZone = gamepadDeadZone;
    this.steer = 0;
    this._resetDown = false;
    this._cameraDown = false;
  }

  update(dt, { keys = {}, touch = {}, gamepad = null } = {}) {
    const padSteer = gamepad ? deadZone(gamepad.axes?.[0] || 0, this.gamepadDeadZone) : 0;
    const keySteer = (keys.KeyA ? -1 : 0) + (keys.KeyD ? 1 : 0);
    const touchSteer = clamp(touch.mx || 0);
    const targetSteer = gamepad ? padSteer : touchSteer || keySteer;
    const rate = targetSteer === 0 ? this.steeringRelease : this.steeringRamp;
    this.steer += clamp(targetSteer - this.steer, -rate * dt, rate * dt);

    const padThrottle = gamepad ? buttonValue(gamepad.buttons?.[7]) : 0;
    const padBrake = gamepad ? buttonValue(gamepad.buttons?.[6]) : 0;
    const touchForward = clamp(-(touch.mz || 0), 0, 1);
    const touchBack = clamp(touch.mz || 0, 0, 1);
    const throttle = clamp(Math.max(keys.KeyW ? 1 : 0, touchForward, padThrottle), 0, 1);
    const brake = clamp(Math.max(keys.KeyS ? 1 : 0, touchBack, padBrake), 0, 1);
    const resetDown = !!keys.KeyR || !!gamepad?.buttons?.[3]?.pressed;
    const cameraDown = !!keys.KeyC || !!gamepad?.buttons?.[0]?.pressed;
    const command = {
      throttle, brake, steer: clamp(this.steer), handbrake: !!keys.Space || !!gamepad?.buttons?.[1]?.pressed,
      reverseIntent: brake > .05, reset: resetDown && !this._resetDown,
      cameraCycle: cameraDown && !this._cameraDown,
    };
    this._resetDown = resetDown;
    this._cameraDown = cameraDown;
    return command;
  }
}

function buttonValue(button) {
  if (!button) return 0;
  return clamp(Number.isFinite(button.value) ? button.value : button.pressed ? 1 : 0, 0, 1);
}

export function activeGamepad(pads) {
  if (!pads) return null;
  for (const pad of pads) if (pad && pad.connected !== false && pad.mapping === 'standard') return pad;
  return null;
}
