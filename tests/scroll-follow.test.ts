import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCROLL_FOLLOW_THRESHOLD,
  distanceFromScrollBottom,
  isNearScrollBottom,
  nextScrollFollowState,
} from '../src/extension/scroll-follow';

test('scroll following remains active within the bottom threshold', () => {
  const metrics = { scrollTop: 1_192, scrollHeight: 1_600, clientHeight: 400 };
  assert.equal(distanceFromScrollBottom(metrics), DEFAULT_SCROLL_FOLLOW_THRESHOLD);
  assert.equal(isNearScrollBottom(metrics), true);
});

test('scroll following pauses after the user moves far enough from the bottom', () => {
  const metrics = { scrollTop: 1_191, scrollHeight: 1_600, clientHeight: 400 };
  assert.equal(distanceFromScrollBottom(metrics), DEFAULT_SCROLL_FOLLOW_THRESHOLD + 1);
  assert.equal(isNearScrollBottom(metrics), false);
});

test('scroll distance is clamped during short or transient layouts', () => {
  const metrics = { scrollTop: 0, scrollHeight: 300, clientHeight: 400 };
  assert.equal(distanceFromScrollBottom(metrics), 0);
  assert.equal(isNearScrollBottom(metrics), true);
});

test('an upward user scroll pauses even inside the bottom tolerance', () => {
  assert.equal(nextScrollFollowState({
    following: true,
    previousScrollTop: 1_198,
    metrics: { scrollTop: 1_194, scrollHeight: 1_600, clientHeight: 400 },
    userDriven: true,
  }), false);
});

test('layout and streaming updates cannot silently restore paused following', () => {
  assert.equal(nextScrollFollowState({
    following: false,
    previousScrollTop: 1_194,
    metrics: { scrollTop: 1_200, scrollHeight: 1_600, clientHeight: 400 },
    userDriven: false,
  }), false);
});

test('following resumes when the user deliberately scrolls down to the end', () => {
  assert.equal(nextScrollFollowState({
    following: false,
    previousScrollTop: 1_180,
    metrics: { scrollTop: 1_196, scrollHeight: 1_600, clientHeight: 400 },
    userDriven: true,
  }), true);
});
