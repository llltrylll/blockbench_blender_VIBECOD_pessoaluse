import { THREE } from '../lib/libs';
import { Canvas } from '../preview/canvas';
import { getSpatialInterval } from './transform';
import { getCubeComponentSelection } from './cube_selection_data';
import { updateCubeComponentOverlay } from './cube_selection';

let active_extrude = null;

const face_directions = {
	east:  {axis: 0, negative: false, normal: [ 1,  0,  0]},
	west:  {axis: 0, negative: true,  normal: [-1,  0,  0]},
	up:    {axis: 1, negative: false, normal: [ 0,  1,  0]},
	down:  {axis: 1, negative: true,  normal: [ 0, -1,  0]},
	south: {axis: 2, negative: false, normal: [ 0,  0,  1]},
	north: {axis: 2, negative: true,  normal: [ 0,  0, -1]},
};

function projectToScreen(point, camera, rect) {
	const projected = point.clone().project(camera);
	return new THREE.Vector2(
		rect.left + (projected.x + 1) * 0.5 * rect.width,
		rect.top + (1 - projected.y) * 0.5 * rect.height
	);
}

function restoreCubeStartState(context) {
	const cube = context.cube;
	cube.from.splice(0, 3, ...context.from);
	cube.to.splice(0, 3, ...context.to);
	cube.uv_offset.splice(0, 2, ...context.uv_offset);
	for (const key in context.face_uv) {
		cube.faces[key].uv = context.face_uv[key].slice();
	}
}

function clearTemporaryResizeData(context) {
	const temp = context.cube.temp_data;
	if (context.had_old_size) temp.old_size = context.previous_old_size;
	else delete temp.old_size;

	if (context.had_old_uv_offset) temp.oldUVOffset = context.previous_old_uv_offset;
	else delete temp.oldUVOffset;
}

function updateExtrude(context, event) {
	const mouse_delta = new THREE.Vector2(
		event.clientX - context.start_mouse.x,
		event.clientY - context.start_mouse.y
	);
	const raw_amount = mouse_delta.dot(context.screen_direction) / context.pixels_per_unit;
	const interval = getSpatialInterval(event);
	const amount = interval > 0 ? Math.round(raw_amount / interval) * interval : raw_amount;

	restoreCubeStartState(context);
	context.cube.resize(context.negative ? -amount : amount, context.axis, context.negative);
	context.amount = amount;
	updateCubeComponentOverlay(context.cube);
	Blockbench.setCursorTooltip('Extrude: ' + (Math.round(amount * 100) / 100));
}

function finishExtrude(commit) {
	const context = active_extrude;
	if (!context) return;
	active_extrude = null;

	document.removeEventListener('mousemove', context.onMouseMove, true);
	context.preview.canvas.removeEventListener('pointerdown', context.onPointerDown, true);
	document.removeEventListener('keydown', context.onKeyDown, true);
	context.preview.canvas.removeEventListener('wheel', context.onWheel, true);
	context.preview.canvas.removeEventListener('contextmenu', context.onContextMenu, true);

	if (commit && Math.abs(context.amount) > 0.0001) {
		Undo.finishEdit('Extrude Cube Face');
	} else {
		Undo.cancelEdit(!commit);
	}

	clearTemporaryResizeData(context);
	Canvas.updateView({
		elements: [context.cube],
		element_aspects: {geometry: true, uv: true, faces: true, transform: true},
		selection: true,
	});
	updateSelection();
	updateCubeComponentOverlay(context.cube);
	Blockbench.setCursorTooltip('');
}

function startExtrude(event) {
	if (active_extrude) return;
	const cube = Cube.selected[0];
	const selection = getCubeComponentSelection(cube);
	if (!cube || !cube.mesh || selection.faces.length !== 1) return;

	const face_key = selection.faces[0];
	const face = cube.faces[face_key];
	const direction = face_directions[face?.direction || face_key];
	const preview = Preview.selected;
	if (!face || !direction || !preview || preview.offscreen || !preview.controls.enabled || preview.walkNavigation?.active) return;

	cube.mesh.updateWorldMatrix(true, false);
	const vertices = cube.getGlobalVertexPositions().map(coords => new THREE.Vector3(...coords).add(scene.position));
	const face_indices = face.getVertexIndices();
	const face_center = new THREE.Vector3();
	face_indices.forEach(index => face_center.add(vertices[index]));
	face_center.divideScalar(face_indices.length);

	const world_normal = new THREE.Vector3(...direction.normal).transformDirection(cube.mesh.matrixWorld).normalize();
	const rect = preview.canvas.getBoundingClientRect();
	const screen_start = projectToScreen(face_center, preview.camera, rect);
	const screen_end = projectToScreen(face_center.clone().add(world_normal), preview.camera, rect);
	const screen_axis = screen_end.sub(screen_start);
	let pixels_per_unit = screen_axis.length();

	if (pixels_per_unit < 0.1) {
		const fallback_scale = preview.calculateControlScale(face_center) || 0.05;
		pixels_per_unit = 1 / fallback_scale;
		screen_axis.set(0, -1);
	}
	if (pixels_per_unit < 0.1 || !Number.isFinite(pixels_per_unit)) return;

	const has_pointer_position = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
		&& (event.clientX !== 0 || event.clientY !== 0);
	const start_mouse = has_pointer_position
		? new THREE.Vector2(event.clientX, event.clientY)
		: new THREE.Vector2(
			rect.left + (preview.mouse.x + 1) * rect.width * 0.5,
			rect.top + (1 - preview.mouse.y) * rect.height * 0.5
		);

	const temp = cube.temp_data;
	const context = {
		cube,
		preview,
		axis: direction.axis,
		negative: direction.negative,
		from: cube.from.slice(),
		to: cube.to.slice(),
		uv_offset: cube.uv_offset.slice(),
		face_uv: Object.fromEntries(Object.keys(cube.faces).map(key => [key, cube.faces[key].uv.slice()])),
		start_mouse,
		screen_direction: screen_axis.normalize(),
		pixels_per_unit,
		amount: 0,
		had_old_size: Object.prototype.hasOwnProperty.call(temp, 'old_size'),
		previous_old_size: temp.old_size,
		had_old_uv_offset: Object.prototype.hasOwnProperty.call(temp, 'oldUVOffset'),
		previous_old_uv_offset: temp.oldUVOffset,
	};
	temp.old_size = cube.size(direction.axis);
	temp.oldUVOffset = cube.uv_offset.slice();

	context.onMouseMove = move_event => {
		if (active_extrude !== context) return;
		move_event.preventDefault();
		move_event.stopImmediatePropagation();
		updateExtrude(context, move_event);
	};
	context.onPointerDown = pointer_event => {
		if (active_extrude !== context) return;
		pointer_event.preventDefault();
		pointer_event.stopImmediatePropagation();
		if (pointer_event.button === 0) {
			finishExtrude(true);
		}
	};
	context.onKeyDown = key_event => {
		if (active_extrude !== context) return;
		key_event.preventDefault();
		key_event.stopImmediatePropagation();
		if (key_event.code === 'Enter' || key_event.code === 'NumpadEnter') {
			finishExtrude(true);
		} else if (key_event.code === 'Escape') {
			finishExtrude(false);
		}
	};
	context.onWheel = wheel_event => {
		if (active_extrude !== context) return;
		wheel_event.preventDefault();
		wheel_event.stopImmediatePropagation();
	};
	context.onContextMenu = menu_event => {
		if (active_extrude !== context) return;
		menu_event.preventDefault();
		menu_event.stopImmediatePropagation();
		finishExtrude(false);
	};

	active_extrude = context;
	Undo.initEdit({elements: [cube]});
	document.addEventListener('mousemove', context.onMouseMove, true);
	preview.canvas.addEventListener('pointerdown', context.onPointerDown, true);
	document.addEventListener('keydown', context.onKeyDown, true);
	preview.canvas.addEventListener('wheel', context.onWheel, {capture: true, passive: false});
	preview.canvas.addEventListener('contextmenu', context.onContextMenu, true);
	Blockbench.showQuickMessage('Extrude: move mouse along face normal · LMB/Enter confirm · RMB/Esc cancel', 4000);
}

BARS.defineActions(() => {
	new Action('extrude_cube_face', {
		name: 'Extrude Cube Face',
		description: 'Extend one native cube face along its normal',
		icon: 'upload',
		category: 'edit',
		keybind: new Keybind({key: 'e'}),
		condition: () => Modes.edit
			&& (BarItems.selection_mode.value === 'face' || BarItems.selection_mode.value === 'cluster')
			&& Cube.selected.length === 1
			&& Outliner.selected.length === 1
			&& getCubeComponentSelection(Cube.selected[0]).faces.length === 1,
		click(event) {
			startExtrude(event);
		}
	});
});
