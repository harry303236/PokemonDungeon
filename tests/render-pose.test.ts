import { describe, expect, it } from 'vitest';
import { renderPose } from '../src/render/views/render-pose';

describe('renderPose', () => {
  it('interpolates from the previous step and snaps teleports', () => {
    expect(renderPose({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toEqual({ x: 0, y: 0 });
    expect(renderPose({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5)).toEqual({ x: 5, y: 0 });
    expect(renderPose({ x: 0, y: 0 }, { x: 10, y: 0 }, 1)).toEqual({ x: 10, y: 0 });
    expect(renderPose({ x: 0, y: 0 }, { x: 200, y: 0 }, 0.5)).toEqual({ x: 200, y: 0 });
    expect(renderPose(undefined, { x: 3, y: 4 }, 0.5)).toEqual({ x: 3, y: 4 });
  });
});
