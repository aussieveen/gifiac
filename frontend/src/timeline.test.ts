import { describe, expect, it } from 'vitest'
import {
  centeredScrollLeft,
  clamp,
  frameIndexForTime,
  linesFromCharTops,
  snapValue,
  spriteBackgroundStyle,
  spriteTileOffset,
  timeToX,
  xToTime,
} from './timeline'

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

describe('linesFromCharTops', () => {
  it('returns the whole text as one line when every character shares a top', () => {
    expect(linesFromCharTops('New caption', () => 10)).toEqual(['New caption'])
  })

  it('splits where the top changes by more than 1px', () => {
    // "New " on one line (top 10), "caption" on the next (top 30) — an
    // auto-wrap, since there's no literal newline in the source text.
    const tops = [10, 10, 10, 10, 30, 30, 30, 30, 30, 30, 30]
    expect(linesFromCharTops('New caption', (i) => tops[i])).toEqual(['New ', 'caption'])
  })

  it('tolerates sub-pixel jitter without treating it as a new line', () => {
    const tops = [10, 10.4, 10.9, 9.6]
    expect(linesFromCharTops('abcd', (i) => tops[i])).toEqual(['abcd'])
  })

  it('skips characters with no measurable position', () => {
    // e.g. a collapsed space at a wrap point — shouldn't itself count as
    // a top change or break the grouping of the real characters.
    const tops: Record<number, number | null> = { 0: 10, 1: null, 2: 30 }
    expect(linesFromCharTops('a b', (i) => tops[i])).toEqual(['a ', 'b'])
  })

  it('strips any literal newline characters from the reconstructed lines', () => {
    // "ab\ncd" -> a,b,\n share top 10 (the \n terminates that line); c,d
    // are on the next line at top 30.
    const tops = [10, 10, 10, 30, 30]
    expect(linesFromCharTops('ab\ncd', (i) => tops[i])).toEqual(['ab', 'cd'])
  })

  it('returns a single empty line for empty text', () => {
    expect(linesFromCharTops('', () => 0)).toEqual([''])
  })
})

describe('snapValue', () => {
  it('passes the value through unchanged when nothing is within range', () => {
    expect(snapValue(5, [1, 10], 1)).toEqual({ value: 5, snappedTo: null })
  })

  it('snaps to a target within the threshold', () => {
    expect(snapValue(5.05, [1, 5, 10], 0.1)).toEqual({ value: 5, snappedTo: 5 })
  })

  it('snaps to the nearest of several targets in range', () => {
    expect(snapValue(5.05, [4.9, 5.0, 10], 0.2)).toEqual({ value: 5.0, snappedTo: 5.0 })
  })

  it('treats the threshold as inclusive', () => {
    expect(snapValue(5.1, [5], 0.1)).toEqual({ value: 5, snappedTo: 5 })
  })

  it('returns the value unchanged for an empty target list', () => {
    expect(snapValue(5, [], 1)).toEqual({ value: 5, snappedTo: null })
  })
})

describe('centeredScrollLeft', () => {
  it('centers a target within a smaller container', () => {
    expect(centeredScrollLeft(500, 200, 1000)).toBe(400)
  })

  it('clamps to 0 when centering would scroll past the start', () => {
    expect(centeredScrollLeft(50, 200, 1000)).toBe(0)
  })

  it('clamps to the max scroll when centering would scroll past the end', () => {
    expect(centeredScrollLeft(950, 200, 1000)).toBe(800)
  })

  it('never scrolls when the content already fits inside the container', () => {
    expect(centeredScrollLeft(100, 800, 700)).toBe(0)
  })
})

describe('spriteBackgroundStyle', () => {
  const grid = { cols: 7, rows: 6, frameWidth: 160, frameHeight: 90 }

  it('builds a CSS background shorthand for a frame at native scale', () => {
    expect(spriteBackgroundStyle(3, grid, '/sprite.jpg', 1)).toEqual({
      backgroundImage: 'url(/sprite.jpg)',
      backgroundSize: '1120px 540px',
      backgroundPosition: '-480px 0px',
    })
  })

  it('scales both the full sheet size and the tile offset together', () => {
    expect(spriteBackgroundStyle(3, grid, '/sprite.jpg', 3)).toEqual({
      backgroundImage: 'url(/sprite.jpg)',
      backgroundSize: '3360px 1620px',
      backgroundPosition: '-1440px 0px',
    })
  })
})
