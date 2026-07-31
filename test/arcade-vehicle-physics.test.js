import test from 'node:test';
import assert from 'node:assert/strict';
import { createVehicleState, stepVehicle } from '../terrain/src/vehicle/ArcadeVehiclePhysics.js';

const environment = {
  sample: () => ({ y: 10, surface: 'asphalt', grip: 1, rollingResistance: .012 }),
  slopeAlong: () => 0,
  sweep: () => false,
};

function run(pattern, seconds = 4, command = { throttle: 1, brake: 0, steer: .2 }) {
  const state = createVehicleState();
  let accumulator = 0, elapsed = 0;
  for (let frame = 0; elapsed < seconds; frame++) {
    const frameDt = pattern[frame % pattern.length];
    elapsed += frameDt; accumulator += frameDt;
    while (accumulator >= 1 / 120) {
      stepVehicle(state, command, environment, 1 / 120);
      accumulator -= 1 / 120;
    }
  }
  return state;
}

test('fixed-step results are deterministic across frame patterns', () => {
  const a = run([1 / 60], 3);
  const b = run([1 / 30, 1 / 120, 1 / 40, 1 / 120], 3);
  assert.ok(Math.abs(a.speed - b.speed) < .15);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < .5);
});

test('brake must reach stopped state before reverse engages', () => {
  const state = createVehicleState({ speed: 12 });
  for (let i = 0; i < 30; i++) stepVehicle(state,
    { throttle: 0, brake: 1, reverseIntent: true, steer: 0 }, environment, 1 / 120);
  assert.equal(state.gear, 'D');
  for (let i = 0; i < 120; i++) stepVehicle(state,
    { throttle: 0, brake: 1, reverseIntent: true, steer: 0 }, environment, 1 / 120);
  assert.equal(state.gear, 'R');
  assert.ok(state.speed < 0);
});

test('surface grip changes acceleration without a hard off-road speed cap', () => {
  const asphalt = run([1 / 120], 2, { throttle: 1, brake: 0, steer: 0 });
  const dirtEnv = { ...environment, sample: () => ({ surface: 'dirt', grip: .45, rollingResistance: .075 }) };
  const dirt = createVehicleState();
  for (let i = 0; i < 240; i++) stepVehicle(dirt, { throttle: 1, brake: 0, steer: 0 }, dirtEnv, 1 / 120);
  assert.ok(asphalt.speed > dirt.speed);
  assert.ok(dirt.speed > 0);
});

test('loose surfaces lengthen braking while retaining stable forward control', () => {
  const stopSpeed = (grip, surface) => {
    const state = createVehicleState({ speed: 18 });
    const env = { ...environment, sample: () => ({
      y: 10, surface, grip, rollingResistance: surface === 'asphalt' ? .012 : .04,
    }) };
    for (let i = 0; i < 60; i++)
      stepVehicle(state, { throttle: 0, brake: 1, steer: .15 }, env, 1 / 120);
    return state;
  };
  const asphalt = stopSpeed(1, 'asphalt');
  const gravel = stopSpeed(.65, 'gravel');
  assert.ok(asphalt.speed < gravel.speed);
  assert.ok(gravel.speed > 0 && Number.isFinite(gravel.yawRate));
});

test('sweep collision projects speed and separates to the reported safe position', () => {
  const state = createVehicleState({ speed: 10 });
  stepVehicle(state, { throttle: 0, brake: 0, steer: 0 }, {
    ...environment, sweep: (_from, _to, hit) => Object.assign(hit,
      { normalX: 0, normalZ: 1, safeX: 2, safeZ: 3, t: .5 }),
  }, 1 / 120);
  assert.equal(state.x, 2);
  assert.equal(state.z, 3);
  assert.ok(state.speed < 0);
  assert.ok(state.feedback.impact > 0);
});

test('glancing barrier collision preserves tangential travel without a bounce-back', () => {
  const state = createVehicleState({ yaw: -.25, speed: 12 });
  stepVehicle(state, { throttle: 0, brake: 0, steer: 0 }, {
    ...environment, sweep: (_from, _to, hit) => Object.assign(hit,
      { normalX: -1, normalZ: 0, safeX: -.02, safeZ: -.09, t: .8 }),
  }, 1 / 120);
  assert.ok(state.speed > 10);
  assert.equal(state.x, -.02);
  assert.equal(state.z, -.09);
  assert.ok(state.feedback.impact > 0);
});

test('collision output is deterministic across identical fixed steps', () => {
  const collide = (_from, _to, hit) => Object.assign(hit,
    { normalX: .6, normalZ: .8, safeX: 1.25, safeZ: -2.5, t: .4 });
  const a = createVehicleState({ yaw: .3, speed: 14 });
  const b = createVehicleState({ yaw: .3, speed: 14 });
  for (const state of [a, b]) stepVehicle(state,
    { throttle: 0, brake: 0, steer: .1 }, { ...environment, sweep: collide }, 1 / 120);
  assert.deepEqual(a, b);
});

test('feedback hooks are deterministic normalized physics outputs', () => {
  const state = createVehicleState();
  stepVehicle(state, { throttle: .8, brake: 0, steer: .7 }, {
    ...environment, sample: () => ({ surface: 'gravel', grip: .65, rollingResistance: .04 }),
  }, 1 / 120);
  for (const value of Object.values(state.feedback))
    assert.ok(value >= 0 && value <= 1);
  assert.ok(state.feedback.engineLoad > 0);
  assert.ok(state.feedback.dust > 0);
});

test('four independent contacts produce bounded pitch and roll', () => {
  const state = createVehicleState();
  const env = {
    ...environment,
    sample: (x, z) => ({ y: 12 + x * .45 + z * .2, surface: 'gravel',
      grip: .65, roughness: .3, rollingResistance: .04 }),
  };
  for (let i = 0; i < 240; i++)
    stepVehicle(state, { throttle: 0, brake: 0, steer: 0 }, env, 1 / 120);
  assert.equal(state.suspension.groundedWheels, 4);
  assert.ok(Math.abs(state.suspension.pitch) > .05);
  assert.ok(Math.abs(state.suspension.roll) > .05);
  assert.ok(Math.abs(state.suspension.pitch) <= .42);
  assert.ok(Math.abs(state.suspension.roll) <= .42);
  for (const wheel of state.suspension.wheels) {
    assert.equal(wheel.grounded, true);
    assert.ok(Number.isFinite(wheel.y));
    assert.ok(wheel.compression >= -1 && wheel.compression <= 1);
  }
});

test('contact loss uses bounded droop and remains deterministic', () => {
  const env = {
    ...environment,
    sample: (x) => x < 0
      ? { y: 4, surface: 'asphalt', grip: 1, rollingResistance: .012 }
      : { y: null, contact: false, surface: 'terrain', grip: .42, rollingResistance: .075 },
  };
  const a = createVehicleState({ y: 4 });
  const b = createVehicleState({ y: 4 });
  for (let i = 0; i < 120; i++) for (const state of [a, b])
    stepVehicle(state, { throttle: 0, brake: 0, steer: 0 }, env, 1 / 120);
  assert.deepEqual(a, b);
  assert.equal(a.suspension.groundedWheels, 2);
  assert.equal(a.suspension.wheels.filter(w => !w.grounded).length, 2);
  assert.ok(Number.isFinite(a.suspension.y));
  assert.ok(Math.abs(a.suspension.roll) <= .42);
  for (const wheel of a.suspension.wheels)
    assert.ok(Number.isFinite(wheel.y) && Math.abs(wheel.velocity) <= 3);
});

test('all-wheel contact loss falls under bounded deterministic gravity', () => {
  const state = createVehicleState({ y: 20 });
  const env = { ...environment, sample: () => ({ contact: false, y: null, surface: 'terrain' }) };
  for (let i = 0; i < 120; i++)
    stepVehicle(state, { throttle: 0, brake: 0, steer: 0 }, env, 1 / 120);
  assert.equal(state.suspension.groundedWheels, 0);
  assert.ok(state.suspension.y < 20);
  assert.ok(state.suspension.heaveVelocity >= -6);
  assert.ok(Number.isFinite(state.suspension.pitch));
  assert.ok(Number.isFinite(state.suspension.roll));
});

test('traction limiting reduces low-grip acceleration without imposing a speed cap', () => {
  const state = createVehicleState({ speed: 14 });
  const dirt = { ...environment,
    sample: () => ({ y: 10, surface: 'dirt', grip: .35, rollingResistance: .075 }) };
  stepVehicle(state, { throttle: 1, brake: 0, steer: .8 }, dirt, 1 / 120);
  assert.ok(state.assists.traction > 0);
  assert.ok(state.speed > 0);
  assert.notEqual(state.speed, 14 * .6);
});

test('hill hold prevents deterministic low-speed rollback on a slope', () => {
  const state = createVehicleState({ speed: .2 });
  const hill = { ...environment, slopeAlong: () => .12 };
  for (let i = 0; i < 120; i++)
    stepVehicle(state, { throttle: 0, brake: 0, steer: 0 }, hill, 1 / 120);
  assert.equal(state.speed, 0);
  assert.equal(state.assists.hillHold, true);
});

test('counter-steer assist damps excessive yaw without reversing driver intent', () => {
  const state = createVehicleState({ speed: 20 });
  state.yawRate = 1.4;
  const dirt = { ...environment,
    sample: () => ({ y: 10, surface: 'dirt', grip: .4, rollingResistance: .075 }) };
  stepVehicle(state, { throttle: .3, brake: 0, steer: .5 }, dirt, 1 / 120);
  assert.ok(state.yawRate < 1.4);
  assert.ok(state.yawRate > 0);
});

test('submerged and invalid terrain recovery requests use deterministic timers', () => {
  const submerged = createVehicleState({ y: 2 });
  const water = { ...environment, isSubmerged: () => true };
  for (let i = 0; i < 60; i++)
    stepVehicle(submerged, { throttle: 0, brake: 0, steer: 0 }, water, 1 / 120);
  assert.equal(submerged.recoveryRequested, true);
  assert.equal(submerged.recoveryReason, 'submerged');

  const outside = createVehicleState({ y: 2 });
  const invalid = { ...environment,
    sample: () => null, heightAt: () => null, validAt: () => false };
  for (let i = 0; i < 90; i++)
    stepVehicle(outside, { throttle: 0, brake: 0, steer: 0 }, invalid, 1 / 120);
  assert.equal(outside.recoveryRequested, true);
  assert.equal(outside.recoveryReason, 'outside-terrain');
});

test('inversion and repeated blocked movement request recovery', () => {
  const inverted = createVehicleState({ y: 2 });
  const upsideDown = { ...environment, vehicleUpY: () => -1 };
  for (let i = 0; i < 150; i++)
    stepVehicle(inverted, { throttle: 0, brake: 0, steer: 0 }, upsideDown, 1 / 120);
  assert.equal(inverted.recoveryRequested, true);
  assert.equal(inverted.recoveryReason, 'inverted');

  const trapped = createVehicleState({ y: 2 });
  const blocked = { ...environment,
    sweep: (_from, _to, hit) => Object.assign(hit, { normalX: 0, normalZ: 1, t: 0 }) };
  for (let i = 0; i < 240; i++)
    stepVehicle(trapped, { throttle: 1, brake: 0, steer: 0 }, blocked, 1 / 120);
  assert.equal(trapped.recoveryRequested, true);
  assert.equal(trapped.recoveryReason, 'trapped');
});

/* Steering authority is the tighter of two limits: the steering lock (a fixed minimum radius,
   so yaw grows with speed) and lateral grip (a_max/v, so yaw falls with speed). These pin the
   handling the driver actually feels — a constant tight circle when manoeuvring, and a widening
   but grip-limited arc once moving. Measured from the traced path, not from the yaw formula. */
function steadyTurn(speed, grip = 1, surface = 'asphalt') {
  const env = {
    sample: () => ({ y: 0, surface, grip, rollingResistance: .012, contact: true, featureId: 'r' }),
    heightAt: () => 0, slopeAlong: () => 0, sweep: () => false,
    validAt: () => true, vehicleUpY: () => 1,
  };
  const state = createVehicleState({ y: 0 });
  const command = { throttle: .35, brake: 0, steer: 1 };
  // hold the speed so the measurement is of turn geometry, not of acceleration
  for (let i = 0; i < 1200; i++) { state.speed = speed; stepVehicle(state, command, env, 1 / 120); }
  let travelled = 0, turned = 0;
  for (let i = 0; i < 600; i++) {
    const px = state.x, pz = state.z, py = state.yaw;
    state.speed = speed;
    stepVehicle(state, command, env, 1 / 120);
    travelled += Math.hypot(state.x - px, state.z - pz);
    turned += Math.abs(Math.atan2(Math.sin(state.yaw - py), Math.cos(state.yaw - py)));
  }
  assert.ok(travelled > 0 && turned > 0, 'car must actually be turning');
  return travelled / turned;                       // arc length / swept angle = radius
}

test('manoeuvring speeds hold a constant steering-lock turning circle', () => {
  // Below the geometry/grip crossover the radius is set by the lock, so it must NOT grow with
  // speed — that growth was the old model's defect. ~5.6 m radius = an ~11.2 m circle.
  const slow = steadyTurn(2.2), walk = steadyTurn(4.5);
  for (const r of [slow, walk]) assert.ok(r > 5 && r < 6.4, `lock-limited radius ${r.toFixed(2)} m`);
  assert.ok(Math.abs(walk - slow) < .5, `radius must stay flat below the crossover: ${slow.toFixed(2)} -> ${walk.toFixed(2)}`);
});

test('turning is grip-limited above the crossover and never exceeds the lateral ceiling', () => {
  let previous = 0;
  for (const v of [8.9, 11.2, 13.4, 16.5]) {
    const r = steadyTurn(v);
    const lateral = v * v / r / 9.81;
    assert.ok(lateral <= .95, `lateral load ${lateral.toFixed(2)}g must stay under the ceiling at ${v} m/s`);
    assert.ok(lateral > .6, `should actually reach the grip limit, got ${lateral.toFixed(2)}g at ${v} m/s`);
    assert.ok(r > previous, `radius must widen with speed: ${r.toFixed(1)} m at ${v} m/s`);
    previous = r;
  }
});

test('loose surfaces widen the grip-limited arc but not the steering lock', () => {
  // A steering lock is mechanical: manoeuvring radius is the same on gravel. Only the
  // grip-limited high-speed arc should open up.
  assert.ok(Math.abs(steadyTurn(2.2, .72, 'gravel') - steadyTurn(2.2)) < .4);
  assert.ok(steadyTurn(13.4, .72, 'gravel') > steadyTurn(13.4) * 1.05);
});
