import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawTownStamp, rasterizeTownStamp } from '../src/structures/townStamp';
import { DEFAULT_TOWN_STYLE, type Town, type TownLabelPosition } from '../src/structures/types';

const town: Town = {
  id: 'town_1', name: 'Highmere', subtitle: 'Market town', u: 0.4, v: 0.5,
  iconId: 'settlement:village', seed: 1234, size: 56, labelPosition: 'below', showLabel: true,
};
const icon = { width: 160, height: 80 } as HTMLImageElement;

function textContext() {
  return {
    font: '', letterSpacing: '0px',
    measureText: (text: string) => ({ width: text.length * 10 }),
    save: vi.fn(), restore: vi.fn(), drawImage: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(),
  };
}

function draw(value: Town, scale = 1) {
  const context = textContext();
  const bounds = drawTownStamp(context as unknown as CanvasRenderingContext2D, value, icon, 100, 200, scale);
  return { context, bounds };
}

afterEach(() => vi.unstubAllGlobals());

describe('town label offset', () => {
  const directions: { position: TownLabelPosition; dx: number; dy: number }[] = [
    { position: 'below', dx: 0, dy: 1 },
    { position: 'above', dx: 0, dy: -1 },
    { position: 'right', dx: 1, dy: 0 },
  ];

  for (const { position, dx, dy } of directions) {
    it.each([[-8, 0.5], [24, 0.5], [-8, 2], [24, 2]])(
      `moves both lines ${position} by offset %s at scale %s without moving the icon`,
      (offset, scale) => {
        const original = draw({ ...town, labelPosition: position }, scale);
        const shifted = draw({ ...town, labelPosition: position, labelOffset: offset }, scale);
        expect(shifted.context.drawImage.mock.calls).toEqual(original.context.drawImage.mock.calls);
        expect(shifted.context.fillText).toHaveBeenCalledTimes(2);
        for (let index = 0; index < 2; index++) {
          const [text, x, y] = original.context.fillText.mock.calls[index];
          const [shiftedText, shiftedX, shiftedY] = shifted.context.fillText.mock.calls[index];
          expect(shiftedText).toBe(text);
          expect(shiftedX).toBeCloseTo(x + offset * scale * dx);
          expect(shiftedY).toBeCloseTo(y + offset * scale * dy);
          expect(shifted.context.strokeText.mock.calls[index]).toEqual([shiftedText, shiftedX, shiftedY]);
        }
      },
    );
  }

  it('preserves existing placement when the offset is missing or reset', () => {
    const original = draw(town);
    const reset = draw({ ...town, labelOffset: 0 });
    expect(reset.context.fillText.mock.calls).toEqual(original.context.fillText.mock.calls);
    expect(reset.bounds).toEqual(original.bounds);
  });

  it('ignores label offsets when labels are hidden', () => {
    const hidden = draw({ ...town, showLabel: false });
    const shifted = draw({ ...town, showLabel: false, labelOffset: 320 });
    expect(shifted.context.fillText).not.toHaveBeenCalled();
    expect(shifted.bounds).toEqual(hidden.bounds);
  });

  it.each(['below', 'above', 'right'] as const)('expands export bounds for a label moved %s', (position) => {
    vi.stubGlobal('document', {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => ({
          ...textContext(),
          getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }),
        }) };
        return canvas;
      },
    });
    // The stubbed canvas cannot paint the icon halo.
    const style = { ...DEFAULT_TOWN_STYLE, iconHaloWidth: 0 };
    const original = rasterizeTownStamp({ ...town, labelPosition: position }, icon, 2, style)!;
    const shifted = rasterizeTownStamp({ ...town, labelPosition: position, labelOffset: 24 }, icon, 2, style)!;
    if (position === 'right') {
      expect(shifted.width - original.width).toBe(48);
      expect(shifted.height).toBe(original.height);
    } else {
      expect(shifted.height - original.height).toBe(48);
      expect(shifted.width).toBe(original.width);
    }
    expect(shifted.anchorX).toBe(original.anchorX);
    expect(shifted.anchorY - original.anchorY).toBe(position === 'above' ? 48 : 0);
  });
});
