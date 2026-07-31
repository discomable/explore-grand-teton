export const SUV_PROFILE = Object.freeze({
  mass: 2240, wheelbase: 2.84, track: 1.6, centerOfMassHeight: .62,
  maxForwardSpeed: 38, maxReverseSpeed: 9, engineAcceleration: 12,
  reverseAcceleration: 9, serviceBrake: 28, drag: .0102, rollingResistance: .35,
  // Steering is bounded by the two limits a real car actually has: the steering lock and
  // wheelbase fix a minimum radius when manoeuvring, and lateral grip caps it once moving.
  // minTurnRadius is measured at the vehicle centre — 5.6 m gives an ~11.2 m kerb-to-kerb
  // circle, typical for an SUV on this wheelbase. maxLateralAccel is the dry-asphalt ceiling
  // before the surface grip term scales it.
  maxSteerRate: 1.65, minTurnRadius: 5.6, maxLateralAccel: 8, yawDamping: .95,
  tractionSlipSpeed: 9, tractionLimit: .52, counterSteer: .24,
  hillHoldSpeed: .55, hillHoldSlope: .025,
  reverseEngageSpeed: .45, reverseDelay: .18,
  suspensionTravel: .42, suspensionRoadFrequency: 7, suspensionTerrainFrequency: 5,
  suspensionDamping: 1.1, antiRoll: .42, maxBodyAngle: .42,
});

export function createVehicleState(initial = {}) {
  const initialY = Number.isFinite(initial.y) ? initial.y : null;
  return {
    x: initial.x || 0, z: initial.z || 0, yaw: initial.yaw || 0,
    speed: initial.speed || 0, steer: initial.steer || 0, yawRate: 0,
    reverseTimer: 0, gear: 'D', surface: 'terrain', grip: .42,
    assists: {
      traction: 0, hillHold: false, trappedTime: 0, invalidTime: 0,
      invertedTime: 0, submergedTime: 0,
    },
    recoveryRequested: false, recoveryReason: null,
    suspension: {
      y: initialY, heaveVelocity: 0, pitch: 0, roll: 0,
      pitchVelocity: 0, rollVelocity: 0, groundedWheels: 0,
      wheels: Array.from({ length: 4 }, () => ({
        y: initialY, velocity: 0, compression: 0, grounded: false,
        surface: 'terrain', roughness: 0,
      })),
    },
    feedback: { engineLoad: 0, tireScrub: 0, dust: 0, impact: 0, brakeLights: 0 },
    telemetry: {
      surface: 'terrain', wheelFallbackCount: 0, contactHeightDisagreement: 0,
      suspensionTravel: 0, verticalAcceleration: 0, surfaceTransitions: 0,
    },
  };
}

export function stepVehicle(state, command, environment, dt, profile = SUV_PROFILE) {
  if (!(dt > 0) || !Number.isFinite(dt)) return state;
  const sampled = environment.sample(state.x, state.z);
  const sample = sampled || terrainContact(environment, state.x, state.z);
  const assists = state.assists || (state.assists = createVehicleState().assists);
  state.recoveryRequested = false;
  state.recoveryReason = null;
  const grip = finite(sample.grip, .42);
  const resistance = finite(sample.rollingResistance, .075);
  state.surface = sample.surface || 'terrain';
  state.grip = grip;
  const previousSurface = state.telemetry?.surface || state.surface;
  stepSuspension(state, environment, dt, profile);
  const telemetry = state.telemetry || (state.telemetry = createVehicleState().telemetry);
  if (previousSurface !== state.surface) telemetry.surfaceTransitions++;
  telemetry.surface = state.surface;

  const steerTarget = clamp(command.steer || 0, -1, 1);
  const steerRate = 7 * dt;
  state.steer += clamp(steerTarget - state.steer, -steerRate, steerRate);

  const braking = clamp(command.brake || 0, 0, 1);
  const throttle = clamp(command.throttle || 0, 0, 1);
  state.feedback.impact = 0;
  if (command.reverseIntent && Math.abs(state.speed) <= profile.reverseEngageSpeed) {
    state.reverseTimer += dt;
    if (state.reverseTimer >= profile.reverseDelay) state.gear = 'R';
  } else if (throttle > .05) {
    state.reverseTimer = 0;
    state.gear = 'D';
  } else if (!command.reverseIntent) state.reverseTimer = 0;

  const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
  const slope = finite(environment.slopeAlong?.(state.x, state.z, fx, fz), 0);
  const speedRatio = clamp(Math.abs(state.speed) / profile.tractionSlipSpeed, 0, 1);
  const demandedSlip = throttle * speedRatio * (1 - clamp(grip, 0, 1)) *
    (1 + Math.abs(state.steer) * .45);
  assists.traction = smooth(.08, .42, demandedSlip);
  const limitedThrottle = throttle * (1 - assists.traction * profile.tractionLimit);
  let acceleration = 0;
  if (state.gear === 'D' && throttle > 0)
    acceleration += profile.engineAcceleration * limitedThrottle * tractionFactor(grip);
  if (braking > 0 && state.speed > profile.reverseEngageSpeed)
    // Loose surfaces lengthen the stop without making the brake ineffective. Asphalt retains
    // the full accessible service-brake response; gravel/track remain controllable rather than
    // snapping to the same deceleration as pavement.
    acceleration -= profile.serviceBrake * braking * (.58 + .42 * clamp(grip, 0, 1));
  else if (state.gear === 'R' && braking > 0)
    acceleration -= profile.reverseAcceleration * braking * tractionFactor(grip);
  acceleration -= 9.81 * slope / Math.sqrt(1 + slope * slope);
  acceleration -= profile.drag * state.speed * Math.abs(state.speed);
  if (Math.abs(state.speed) > .02)
    acceleration -= Math.sign(state.speed) * (profile.rollingResistance + resistance * 6);

  // Hold a stopped vehicle on a grade until the driver deliberately asks it to move.
  assists.hillHold = Math.abs(state.speed) < profile.hillHoldSpeed &&
    Math.abs(slope) > profile.hillHoldSlope && throttle < .05 && braking < .05;
  if (assists.hillHold) { acceleration = 0; state.speed = 0; }

  state.speed = clamp(state.speed + acceleration * dt, -profile.maxReverseSpeed, profile.maxForwardSpeed);
  if (!throttle && !braking && Math.abs(state.speed) < .12) state.speed = 0;

  // Yaw authority = the tighter of the two real limits.
  //   geometry: steering lock + wheelbase fix a minimum radius, so yaw grows WITH speed
  //   grip:     lateral acceleration is capped, so yaw falls as a_max / v
  // The old model was a single 1/(1+kv) falloff, which is neither: it started widening the
  // radius the instant the car moved off, so the circle was 13.7 m at 12 mph and 41 m at
  // 25 mph while never exceeding 0.69 g — artificially wide rather than grip-limited.
  // Surface grip scales the lateral-acceleration ceiling only; a steering lock is a steering
  // lock on gravel too, and at manoeuvring speed the grip term is nowhere near binding.
  const speedAbs = Math.abs(state.speed);
  // engagement only has to suppress pivot-on-the-spot now that the geometry term already
  // scales with speed, so it can hand over control much earlier than the old 3.5 m/s.
  const engagement = smooth(.15, 1.2, speedAbs);
  const geometryYaw = speedAbs / profile.minTurnRadius;
  const gripYaw = profile.maxLateralAccel * (.55 + .45 * grip) / Math.max(speedAbs, .5);
  let desiredYawRate = -state.steer * engagement *
    Math.min(geometryYaw, gripYaw, profile.maxSteerRate) *
    (state.speed < 0 ? -1 : 1);
  // Accessible stability assist: when actual yaw exceeds available-grip steering yaw, blend a
  // small counter-steer correction into the target. It never overrides the driver's direction.
  const yawError = state.yawRate - desiredYawRate;
  desiredYawRate += clamp(yawError * -profile.counterSteer * speedRatio * (1.15 - grip), -.35, .35);
  state.yawRate += (desiredYawRate - state.yawRate) * Math.min(1, profile.yawDamping * 8 * dt);
  state.yaw += state.yawRate * dt;

  const nx = state.x - Math.sin(state.yaw) * state.speed * dt;
  const nz = state.z - Math.cos(state.yaw) * state.speed * dt;
  const hit = {};
  if (environment.sweep?.({ x: state.x, z: state.z }, { x: nx, z: nz }, hit)) {
    let normalX = finite(hit.normalX, 0), normalZ = finite(hit.normalZ, 0);
    const normalLength = Math.hypot(normalX, normalZ);
    if (normalLength > 1e-6) { normalX /= normalLength; normalZ /= normalLength; }
    else { normalX = -fx; normalZ = -fz; }
    const forwardDotNormal = fx * normalX + fz * normalZ;
    const normalSpeed = state.speed * forwardDotNormal;
    // Remove inward velocity and retain only restrained restitution. Projecting with the actual
    // barrier normal lets a glancing impact continue along a rail instead of bouncing backwards.
    if (normalSpeed < 0)
      state.speed -= (1.08 * normalSpeed) * forwardDotNormal;
    const contactT = clamp(finite(hit.t, 0), 0, 1);
    const contactX = state.x + (nx - state.x) * contactT;
    const contactZ = state.z + (nz - state.z) * contactT;
    state.x = finite(hit.safeX, contactX + normalX * .08);
    state.z = finite(hit.safeZ, contactZ + normalZ * .08);
    state.feedback.impact = clamp(Math.abs(normalSpeed) / 12, 0, 1);
    assists.trappedTime = Math.abs(state.speed) < 1.2 && (throttle > .6 || braking > .6)
      ? assists.trappedTime + dt : Math.max(0, assists.trappedTime - dt * 2);
  } else {
    state.x = nx; state.z = nz;
    assists.trappedTime = Math.max(0, assists.trappedTime - dt * 2);
  }
  updateRecovery(state, environment, sampled, dt);
  state.feedback.engineLoad = clamp(throttle * (1 - Math.abs(state.speed) / profile.maxForwardSpeed) + Math.abs(slope) * .4, 0, 1);
  state.feedback.tireScrub = clamp(Math.abs(state.steer) * Math.abs(state.speed) / 18 * (1.25 - grip), 0, 1);
  state.feedback.dust = state.surface === 'asphalt' ? 0 :
    clamp(Math.abs(state.speed) / 18 * (1 - grip * .35), 0, 1);
  state.feedback.brakeLights = braking;
  return state;
}

function updateRecovery(state, environment, sampled, dt) {
  const a = state.assists;
  const valid = sampled && Number.isFinite(sampled.y) &&
    environment.validAt?.(state.x, state.z) !== false;
  a.invalidTime = valid ? 0 : a.invalidTime + dt;
  a.submergedTime = environment.isSubmerged?.(state.x, state.z,
    state.suspension?.y) ? a.submergedTime + dt : 0;
  const upY = finite(environment.vehicleUpY?.(), Math.cos(state.suspension?.roll || 0) *
    Math.cos(state.suspension?.pitch || 0));
  a.invertedTime = upY < .2 ? a.invertedTime + dt : 0;
  let reason = null;
  const epsilon = 1e-9;
  if (a.submergedTime + epsilon >= .5) reason = 'submerged';
  else if (a.invalidTime + epsilon >= .75) reason = 'outside-terrain';
  else if (a.invertedTime + epsilon >= 1.25) reason = 'inverted';
  else if (a.trappedTime + epsilon >= 2) reason = 'trapped';
  if (reason) {
    state.recoveryRequested = true;
    state.recoveryReason = reason;
    a.submergedTime = a.invalidTime = a.invertedTime = a.trappedTime = 0;
  }
}

// Wheel order is front-left, front-right, rear-left, rear-right. The result is presentation-ready:
// callers use suspension.y/pitch/roll directly and never repeat contact or spring calculations.
function stepSuspension(state, environment, dt, profile) {
  const suspension = state.suspension || (state.suspension = createVehicleState().suspension);
  const halfWB = profile.wheelbase * .5, halfTrack = profile.track * .5;
  const sin = Math.sin(state.yaw), cos = Math.cos(state.yaw);
  const fx = -sin, fz = -cos, rx = cos, rz = -sin;
  const offsets = [
    [halfWB, -halfTrack], [halfWB, halfTrack],
    [-halfWB, -halfTrack], [-halfWB, halfTrack],
  ];
  let validCount = 0, roadFirmness = 0, fallbackCount = 0;
  const heights = new Array(4);
  for (let i = 0; i < 4; i++) {
    const [forward, right] = offsets[i];
    const x = state.x + fx * forward + rx * right;
    const z = state.z + fz * forward + rz * right;
    const contact = environment.sample(x, z) || terrainContact(environment, x, z);
    const groundY = finite(contact.y, NaN);
    const grounded = contact.contact !== false && Number.isFinite(groundY);
    const wheel = suspension.wheels[i];
    wheel.grounded = grounded;
    wheel.surface = contact.surface || 'terrain';
    if (!contact.featureId || wheel.surface === 'terrain') fallbackCount++;
    wheel.roughness = clamp(finite(contact.roughness, surfaceResponse(wheel.surface).roughness), 0, 1);
    if (grounded) {
      const response = surfaceResponse(wheel.surface);
      const frequency = lerp(profile.suspensionTerrainFrequency, profile.suspensionRoadFrequency,
        response.firmness);
      if (!Number.isFinite(wheel.y)) { wheel.y = groundY; wheel.velocity = 0; }
      springStep(wheel, groundY, frequency, profile.suspensionDamping, dt);
      wheel.y = clamp(wheel.y, groundY - profile.suspensionTravel, groundY + profile.suspensionTravel);
      wheel.compression = clamp((groundY - wheel.y) / profile.suspensionTravel, -1, 1);
      heights[i] = wheel.y;
      roadFirmness += response.firmness;
      validCount++;
    } else {
      // A missing sample means the wheel is airborne. Extend it only to finite suspension droop;
      // never let invalid terrain inject NaNs or an unbounded body impulse.
      wheel.velocity = clamp(wheel.velocity - 9.81 * dt, -3, 3);
      const bodyY = Number.isFinite(suspension.y) ? suspension.y : 0;
      wheel.y = clamp(finite(wheel.y, bodyY), bodyY - profile.suspensionTravel, bodyY);
      wheel.compression = -1;
      heights[i] = NaN;
    }
  }
  suspension.groundedWheels = validCount;
  const telemetry = state.telemetry || (state.telemetry = createVehicleState().telemetry);
  telemetry.wheelFallbackCount = fallbackCount;
  if (!validCount) {
    suspension.heaveVelocity = clamp(suspension.heaveVelocity - 9.81 * dt, -6, 6);
    suspension.y = finite(suspension.y, 0) + suspension.heaveVelocity * dt;
    suspension.pitchVelocity *= Math.exp(-5 * dt);
    suspension.rollVelocity *= Math.exp(-5 * dt);
    return;
  }
  let groundedMean = 0;
  for (const height of heights) if (Number.isFinite(height)) groundedMean += height;
  groundedMean /= validCount;
  const fallback = finite(suspension.y, groundedMean);
  for (let i = 0; i < 4; i++) if (!Number.isFinite(heights[i])) heights[i] = fallback;
  const targetY = (heights[0] + heights[1] + heights[2] + heights[3]) * .25;
  const finiteHeights = heights.filter(Number.isFinite);
  telemetry.contactHeightDisagreement = finiteHeights.length
    ? Math.max(...finiteHeights) - Math.min(...finiteHeights) : 0;
  telemetry.suspensionTravel = Math.max(...suspension.wheels.map(w => Math.abs(w.compression))) *
    profile.suspensionTravel;
  const previousHeaveVelocity = suspension.heaveVelocity;
  const targetPitch = clamp(Math.atan2((heights[0] + heights[1] - heights[2] - heights[3]) * .5,
    profile.wheelbase), -profile.maxBodyAngle, profile.maxBodyAngle);
  let targetRoll = clamp(Math.atan2((heights[1] + heights[3] - heights[0] - heights[2]) * .5,
    profile.track), -profile.maxBodyAngle, profile.maxBodyAngle);
  // Anti-roll support reduces differential suspension travel without flattening the terrain slope.
  const leftCompression = suspension.wheels[0].compression + suspension.wheels[2].compression;
  const rightCompression = suspension.wheels[1].compression + suspension.wheels[3].compression;
  targetRoll -= clamp((rightCompression - leftCompression) * profile.antiRoll * .08, -.1, .1);
  const firmness = roadFirmness / validCount;
  const bodyFrequency = lerp(profile.suspensionTerrainFrequency, profile.suspensionRoadFrequency, firmness);
  const body = { y: finite(suspension.y, targetY), velocity: suspension.heaveVelocity };
  springStep(body, targetY, bodyFrequency, profile.suspensionDamping, dt);
  suspension.y = clamp(body.y, targetY - profile.suspensionTravel, targetY + profile.suspensionTravel);
  suspension.heaveVelocity = clamp(body.velocity, -6, 6);
  telemetry.verticalAcceleration = (suspension.heaveVelocity - previousHeaveVelocity) / dt;
  [suspension.pitch, suspension.pitchVelocity] = angularSpring(
    suspension.pitch, suspension.pitchVelocity, targetPitch, bodyFrequency, dt, profile.maxBodyAngle);
  [suspension.roll, suspension.rollVelocity] = angularSpring(
    suspension.roll, suspension.rollVelocity, targetRoll, bodyFrequency, dt, profile.maxBodyAngle);
}

function springStep(body, target, frequency, damping, dt) {
  const w = Math.max(.1, frequency) * Math.max(.25, damping);
  const x = finite(body.y, target) - target, v = finite(body.velocity, 0);
  const e = Math.exp(-w * dt), c = (v + w * x) * dt;
  body.y = target + (x + c) * e;
  body.velocity = (v - w * c) * e;
}
function angularSpring(value, velocity, target, frequency, dt, limit) {
  const body = { y: finite(value, target), velocity: finite(velocity, 0) };
  springStep(body, target, frequency, 1, dt);
  return [clamp(body.y, -limit, limit), clamp(body.velocity, -4, 4)];
}
function surfaceResponse(surface) {
  switch (surface) {
    case 'asphalt': case 'paved': case 'bridge_deck': return { firmness: 1, roughness: .05 };
    case 'gravel': return { firmness: .72, roughness: .3 };
    case 'two_track': case 'dirt': return { firmness: .42, roughness: .62 };
    default: return { firmness: .25, roughness: .78 };
  }
}

function terrainContact(environment, x, z) {
  return { y: environment.heightAt?.(x, z), surface: 'terrain',
    grip: .42, rollingResistance: .075 };
}
function tractionFactor(grip) { return .58 + .42 * clamp(grip, 0, 1); }
function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth(a, b, v) { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
