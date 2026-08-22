import { describe, expect, it } from 'vitest'
import { clamp, frameIndexForTime, spriteTileOffset, timeToX, xToTime } from './timeline'

describe('clamp', () => {
  it('passes values already in range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('clamps below the minimum', () => {
    expect(clamp(-3, 0, 10)).toBe(0)
  })

  it('clamps above the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })
})

describe('timeToX / xToTime', () => {
  it('round-trips a time through pixel space', () => {
    const duration = 8
    const width = 700
    const t = 3.5
    expect(xToTime(timeToX(t, duration, width), duration, width)).toBeCloseTo(t, 5)
  })

  it('maps time 0 to x 0 and duration to the full width', () => {
    expect(timeToX(0, 8, 700)).toBe(0)
    expect(timeToX(8, 8, 700)).toBe(700)
  })

  it('clamps x outside the timeline to the clip bounds', () => {
    expect(xToTime(-50, 8, 700)).toBe(0)
    expect(xToTime(9999, 8, 700)).toBe(8)
  })

  it('treats a zero-duration clip as all-zero instead of dividing by zero', () => {
    expect(timeToX(0, 0, 700)).toBe(0)
    expect(xToTime(350, 0, 700)).toBe(0)
  })
})

describe('frameIndexForTime', () => {
  it('picks the frame whose interval the time falls into', () => {
    expect(frameIndexForTime(0, 0.25, 40)).toBe(0)
    expect(frameIndexForTime(0.24, 0.25, 40)).toBe(0)
    expect(frameIndexForTime(0.25, 0.25, 40)).toBe(1)
    expect(frameIndexForTime(1.0, 0.25, 40)).toBe(4)
  })

  it('clamps to the last frame at the end of the clip', () => {
    expect(frameIndexForTime(10.0, 0.25, 40)).toBe(39)
    expect(frameIndexForTime(9.99, 0.25, 40)).toBe(39)
  })

  it('clamps negative time to frame 0', () => {
    expect(frameIndexForTime(-1, 0.25, 40)).toBe(0)
  })

  it('never picks a frame beyond a single-frame strip', () => {
    expect(frameIndexForTime(5, 0.25, 1)).toBe(0)
  })
})

describe('spriteTileOffset', () => {
  it('places frame 0 at the sprite origin', () => {
    expect(spriteTileOffset(0, { cols: 7, frameWidth: 160, frameHeight: 90 })).toEqual({
      backgroundPositionX: 0,
      backgroundPositionY: 0,
    })
  })

  it('advances horizontally within a row', () => {
    expect(spriteTileOffset(3, { cols: 7, frameWidth: 160, frameHeight: 90 })).toEqual({
      backgroundPositionX: -480,
      backgroundPositionY: 0,
    })
  })

  it('wraps to the next row after `cols` frames', () => {
    expect(spriteTileOffset(7, { cols: 7, frameWidth: 160, frameHeight: 90 })).toEqual({
      backgroundPositionX: 0,
      backgroundPositionY: -90,
    })
    expect(spriteTileOffset(9, { cols: 7, frameWidth: 160, frameHeight: 90 })).toEqual({
      backgroundPositionX: -320,
      backgroundPositionY: -90,
    })
  })
})
