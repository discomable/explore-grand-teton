import test from 'node:test';
import assert from 'node:assert/strict';
import { DrivingInput, activeGamepad } from '../terrain/src/vehicle/DrivingInput.js';

test('keyboard steering ramps instead of snapping', () => {
  const input = new DrivingInput({ steeringRamp: 4 });
  const first = input.update(1 / 120, { keys: { KeyA: true } });
  assert.ok(first.steer < 0 && first.steer > -.04);
  for (let i = 0; i < 30; i++) input.update(1 / 120, { keys: { KeyA: true } });
  assert.ok(input.steer < -.9);
});

test('touch separates forward throttle from backward brake', () => {
  const input = new DrivingInput();
  assert.deepEqual(input.update(.1, { touch: { mz: -.7 } }).throttle, .7);
  const back = input.update(.1, { touch: { mz: .8 } });
  assert.equal(back.throttle, 0);
  assert.equal(back.brake, .8);
  assert.equal(back.reverseIntent, true);
});

test('standard gamepad uses analog stick and triggers with dead zones', () => {
  const input = new DrivingInput({ steeringRamp: 100 });
  const buttons = Array.from({ length: 8 }, () => ({ value: 0, pressed: false }));
  buttons[7] = { value: .65, pressed: true };
  const command = input.update(.1, { gamepad: { axes: [.5], buttons } });
  assert.equal(command.throttle, .65);
  assert.ok(command.steer > .4);
});

test('reset and camera commands are edge triggered', () => {
  const input = new DrivingInput();
  assert.equal(input.update(.1, { keys: { KeyR: true } }).reset, true);
  assert.equal(input.update(.1, { keys: { KeyR: true } }).reset, false);
  input.update(.1, {});
  assert.equal(input.update(.1, { keys: { KeyR: true } }).reset, true);
});

test('activeGamepad selects a connected standard controller', () => {
  const expected = { connected: true, mapping: 'standard' };
  assert.equal(activeGamepad([null, { connected: true, mapping: '' }, expected]), expected);
  assert.equal(activeGamepad([]), null);
});
