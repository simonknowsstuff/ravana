import { useCallback, RefObject } from 'react';

/**
 * Hook that returns a function capable of exporting a referenced canvas
 * element to a PNG file.  The returned callback will silently do nothing
 * if the ref is not yet populated.
 *
 * @param canvasRef ref of the canvas you want to export
 * @returns callback that accepts an optional filename string
 */
export function useCanvasExporter(canvasRef: RefObject<HTMLCanvasElement>) {
  return useCallback(
    (filename?: string) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        console.warn('useCanvasExporter: canvas ref is not attached');
        return;
      }

      const a = document.createElement('a');
      a.download = filename ?? `ravana-render-${Date.now()}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    },
    [canvasRef]
  );
}
