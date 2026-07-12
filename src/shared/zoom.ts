/**
 * Preview zoom -> display-width mapping.
 *
 * Zoom is a plain percentage (default/reset 100 = fills the panel width).
 * It is panel-relative and STICKY: the percentage means "rendered page width
 * as a fraction of the panel's fit width", and keeps meaning that as the
 * panel resizes — pageDisplayWidthPx recomputes from the live container
 * width on every call, so at a fixed %, dragging the divider rescales the
 * page to stay that fraction of the panel; the displayed % never drifts.
 *
 * Pure logic, zero Vue/runtime dependencies — imported by
 * TabLayoutRenderer.vue (display width) and TabPreview.vue (zoom stepping).
 */

export type ZoomState = number;

// containerWidth arrives padding-free: TabPreview measures clientWidth minus
// computed padding, so 100% fills the content box exactly.
export function pageDisplayWidthPx(zoom: ZoomState, containerWidth: number): number {
	return Math.round(containerWidth * (zoom / 100));
}

// Step zoom by `step` in `direction`, clamped to [min, max].
export function stepZoom(current: ZoomState, direction: 1 | -1, step: number, min: number, max: number): ZoomState {
	return Math.min(max, Math.max(min, current + direction * step));
}
