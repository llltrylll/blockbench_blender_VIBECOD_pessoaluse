import { THREE } from '../lib/libs';
import { Canvas } from '../preview/canvas';
import { Cube } from '../outliner/types/cube';
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

const cube_vertex_signs = [
	[ 1,  1,  1], [ 1,  1, -1], [ 1, -1,  1], [ 1, -1, -1],
	[-1,  1, -1], [-1,  1,  1], [-1, -1, -1], [-1, -1,  1],
];

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

function updateFaceExtrude(context, event) {
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

function faceKeyForAxis(axis, sign) {
	if (axis === 0) return sign > 0 ? 'east' : 'west';
	if (axis === 1) return sign > 0 ? 'up' : 'down';
	return sign > 0 ? 'south' : 'north';
}

function edgeCandidates(cube, edge, world_vertices, preview) {
	const [a, b] = edge.map(Number);
	if (!Number.isInteger(a) || !Number.isInteger(b) || !world_vertices[a] || !world_vertices[b]) return [];

	const differing_axes = [0, 1, 2].filter(axis => cube_vertex_signs[a][axis] !== cube_vertex_signs[b][axis]);
	if (differing_axes.length !== 1) return [];
	const edge_axis = differing_axes[0];
	const fixed_axes = [0, 1, 2].filter(axis => axis !== edge_axis);
	const midpoint = world_vertices[a].clone().add(world_vertices[b]).multiplyScalar(0.5);
	const rect = preview.canvas.getBoundingClientRect();
	const screen_start = projectToScreen(midpoint, preview.camera, rect);

	return fixed_axes.map(move_axis => {
		const source_axis = fixed_axes.find(axis => axis !== move_axis);
		const move_sign = cube_vertex_signs[a][move_axis];
		const source_sign = cube_vertex_signs[a][source_axis];
		const local_normal = [0, 0, 0];
		local_normal[move_axis] = move_sign;
		const world_normal = new THREE.Vector3(...local_normal).transformDirection(cube.mesh.matrixWorld).normalize();
		const screen_axis = projectToScreen(midpoint.clone().add(world_normal), preview.camera, rect).sub(screen_start);
		const pixels_per_unit = screen_axis.length();

		return {
			move_axis,
			move_sign,
			source_axis,
			source_sign,
			world_normal,
			screen_direction: screen_axis.normalize(),
			pixels_per_unit,
		};
	}).filter(candidate => candidate.pixels_per_unit > 0.1 && Number.isFinite(candidate.pixels_per_unit));
}

function copyCubeFaceData(cube) {
	const faces = {};
	for (const direction of Object.keys(cube.faces)) {
		faces[direction] = cube.faces[direction].getSaveCopy();
		if (faces[direction].uv instanceof Array) faces[direction].uv = faces[direction].uv.slice();
	}
	return faces;
}

function updateEdgeCuboid(context, amount) {
	const cube = context.cube;
	const candidate = context.candidate;
	const active = amount > 0.0001;

	if (!context.extruded_cube && !active) return;

	if (!context.extruded_cube) {
		const back_face = faceKeyForAxis(candidate.move_axis, -candidate.move_sign);
		const faces = copyCubeFaceData(cube);
		faces[back_face].enabled = false;
		context.extruded_cube = new Cube({
			name: cube.name + '_Extrude',
			from: context.adjusted_from.slice(),
			to: context.adjusted_to.slice(),
			origin: cube.origin.slice(),
			rotation: cube.rotation.slice(),
			inflate: 0,
			stretch: [1, 1, 1],
			uv_offset: cube.uv_offset.slice(),
			autouv: cube.autouv,
			color: cube.color,
			shade: cube.shade,
			mirror_uv: cube.mirror_uv,
			export: cube.export,
			visibility: true,
			faces,
		});
		// New cubes in a bone/group hierarchy must retain the source element's scope.
		context.extruded_cube.scope = cube.scope;
		context.extruded_cube.sortInBefore(cube, 0).init();
	}

	const from = context.adjusted_from.slice();
	const to = context.adjusted_to.slice();
	const source_size = context.adjusted_to[candidate.source_axis] - context.adjusted_from[candidate.source_axis];
	const thickness = Math.min(1, source_size);
	if (candidate.source_sign > 0) {
		from[candidate.source_axis] = context.adjusted_to[candidate.source_axis] - thickness;
		to[candidate.source_axis] = context.adjusted_to[candidate.source_axis];
	} else {
		from[candidate.source_axis] = context.adjusted_from[candidate.source_axis];
		to[candidate.source_axis] = context.adjusted_from[candidate.source_axis] + thickness;
	}
	if (candidate.move_sign > 0) {
		from[candidate.move_axis] = context.adjusted_to[candidate.move_axis];
		to[candidate.move_axis] = context.adjusted_to[candidate.move_axis] + amount;
	} else {
		from[candidate.move_axis] = context.adjusted_from[candidate.move_axis] - amount;
		to[candidate.move_axis] = context.adjusted_from[candidate.move_axis];
	}

	context.extruded_cube.from.splice(0, 3, ...from);
	context.extruded_cube.to.splice(0, 3, ...to);
	context.extruded_cube.visibility = active;

	context.extruded_cube.preview_controller.updateTransform(context.extruded_cube);
	context.extruded_cube.preview_controller.updateGeometry(context.extruded_cube);
	context.extruded_cube.preview_controller.updateFaces(context.extruded_cube);
	context.extruded_cube.preview_controller.updateUV(context.extruded_cube);
	cube.preview_controller.updateFaces(cube);
}

function updateEdgeExtrude(context, event) {
	const mouse_delta = new THREE.Vector2(
		event.clientX - context.start_mouse.x,
		event.clientY - context.start_mouse.y
	);
	if (!context.candidate) {
		if (mouse_delta.length() < 4) return;
		let best_score = 0;
		context.candidates.forEach(candidate => {
			const score = mouse_delta.dot(candidate.screen_direction);
			if (score > best_score) {
				best_score = score;
				context.candidate = candidate;
			}
		});
		if (!context.candidate) {
			Blockbench.setCursorTooltip('Drag outward along either adjacent face');
			return;
		}
	}
	const raw_amount = mouse_delta.dot(context.candidate.screen_direction) / context.candidate.pixels_per_unit;
	const interval = getSpatialInterval(event);
	const amount = Math.max(0, interval > 0 ? Math.round(raw_amount / interval) * interval : raw_amount);
	context.amount = amount;
	if (amount > 0.0001 || context.extruded_cube) updateEdgeCuboid(context, amount);
	Blockbench.setCursorTooltip('Extrude Edge: ' + (Math.round(amount * 100) / 100));
}

function cleanupModal(context) {
	document.removeEventListener('mousemove', context.onMouseMove, true);
	context.preview.canvas.removeEventListener('pointerdown', context.onPointerDown, true);
	document.removeEventListener('keydown', context.onKeyDown, true);
	context.preview.canvas.removeEventListener('wheel', context.onWheel, true);
	context.preview.canvas.removeEventListener('contextmenu', context.onContextMenu, true);
	Blockbench.setCursorTooltip('');
}

function finishExtrude(commit) {
	const context = active_extrude;
	if (!context) return;
	active_extrude = null;
	cleanupModal(context);

	if (context.type === 'edge') {
		if (commit && context.extruded_cube && context.amount > 0.0001) {
			unselectAllElements();
			context.extruded_cube.select();
			const far_edge = cube_vertex_signs
				.map((signs, index) => ({signs, index}))
				.filter(entry =>
					entry.signs[context.candidate.move_axis] === context.candidate.move_sign &&
					entry.signs[context.candidate.source_axis] === context.candidate.source_sign
				)
				.map(entry => String(entry.index));
			const components = getCubeComponentSelection(context.extruded_cube, true);
			components.vertices.replace(far_edge);
			components.edges.replace([far_edge]);
			components.faces.empty();
			updateSelection();
			Canvas.updateView({
				elements: [context.cube, context.extruded_cube],
				element_aspects: {geometry: true, uv: true, faces: true, transform: true},
				selection: true,
			});
			updateCubeComponentOverlay(context.extruded_cube);
			Undo.finishEdit('Extrude Cube Edge', {
				elements: [context.cube, context.extruded_cube],
				outliner: true,
				selection: true,
			});
		} else {
			Undo.cancelEdit(true);
			Canvas.updateView({elements: [context.cube], element_aspects: {geometry: true, faces: true}, selection: true});
			updateSelection();
			updateCubeComponentOverlay(context.cube);
		}
		return;
	}

	if (commit && Math.abs(context.amount) > 0.0001) {
		Undo.finishEdit('Extrude Cube Face');
	} else {
		Undo.cancelEdit(true);
	}

	clearTemporaryResizeData(context);
	Canvas.updateView({
		elements: [context.cube],
		element_aspects: {geometry: true, uv: true, faces: true, transform: true},
		selection: true,
	});
	updateSelection();
	updateCubeComponentOverlay(context.cube);
}

function bindModalEvents(context) {
	context.onMouseMove = move_event => {
		if (active_extrude !== context) return;
		move_event.preventDefault();
		move_event.stopImmediatePropagation();
		if (context.type === 'edge') updateEdgeExtrude(context, move_event);
		else updateFaceExtrude(context, move_event);
	};
	context.onPointerDown = pointer_event => {
		if (active_extrude !== context) return;
		pointer_event.preventDefault();
		pointer_event.stopImmediatePropagation();
		if (pointer_event.button === 0) finishExtrude(true);
		else if (pointer_event.button === 2) {
			context.preview.suppressNextRightClickMenu?.();
			finishExtrude(false);
		}
	};
	context.onKeyDown = key_event => {
		if (active_extrude !== context) return;
		key_event.preventDefault();
		key_event.stopImmediatePropagation();
		if (key_event.code === 'Enter' || key_event.code === 'NumpadEnter') finishExtrude(true);
		else if (key_event.code === 'Escape') finishExtrude(false);
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
		// The contextmenu event is already being consumed. Do not suppress the
		// next independent right-button mouseup.
		context.preview.suppressNextRightClickMenu?.(false);
		finishExtrude(false);
	};

	active_extrude = context;
	document.addEventListener('mousemove', context.onMouseMove, true);
	context.preview.canvas.addEventListener('pointerdown', context.onPointerDown, true);
	document.addEventListener('keydown', context.onKeyDown, true);
	context.preview.canvas.addEventListener('wheel', context.onWheel, {capture: true, passive: false});
	context.preview.canvas.addEventListener('contextmenu', context.onContextMenu, true);
}

function startFaceExtrude(event, cube, face_key, preview) {
	const face = cube.faces[face_key];
	const direction = face_directions[face?.direction || face_key];
	if (!face || !direction) return;

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
		type: 'face',
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
	Undo.initEdit({elements: [cube]});
	bindModalEvents(context);
	Blockbench.showQuickMessage('Extrude Face: drag along normal · LMB/Enter confirm · RMB/Esc cancel', 4000);
}

function startEdgeExtrude(event, cube, edge, preview) {
	cube.mesh.updateWorldMatrix(true, false);
	const world_vertices = cube.getGlobalVertexPositions().map(coords => new THREE.Vector3(...coords).add(scene.position));
	const candidates = edgeCandidates(cube, edge, world_vertices, preview);
	if (!candidates.length) return;

	const rect = preview.canvas.getBoundingClientRect();
	const has_pointer_position = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
		&& (event.clientX !== 0 || event.clientY !== 0);
	const start_mouse = has_pointer_position
		? new THREE.Vector2(event.clientX, event.clientY)
		: new THREE.Vector2(
			rect.left + (preview.mouse.x + 1) * rect.width * 0.5,
			rect.top + (1 - preview.mouse.y) * rect.height * 0.5
		);

	const adjusted_from = cube.from.slice();
	const adjusted_to = cube.to.slice();
	adjustFromAndToForInflateAndStretch(adjusted_from, adjusted_to, cube);

	const context = {
		type: 'edge',
		cube,
		preview,
		edge: edge.slice(),
		world_vertices,
		candidates,
		candidate: null,
		start_mouse,
		amount: 0,
		adjusted_from,
		adjusted_to,
		extruded_cube: null,
	};
	Undo.initEdit({elements: [cube], outliner: true, selection: true});
	bindModalEvents(context);
	Blockbench.showQuickMessage('Extrude Edge: drag outward along either adjacent face · LMB/Enter confirm · RMB/Esc cancel', 5000);
}

export function startCubeExtrude(event) {
	if (active_extrude) return;
	const cube = Cube.selected[0];
	if (!cube || !cube.mesh || Cube.selected.length !== 1 || Outliner.selected.length !== 1) return;

	const selection = getCubeComponentSelection(cube);
	const preview = Preview.selected;
	if (!preview || preview.offscreen || !preview.controls.enabled || preview.walkNavigation?.active) return;

	if ((BarItems.selection_mode.value === 'face' || BarItems.selection_mode.value === 'cluster') && selection.faces.length === 1) {
		startFaceExtrude(event, cube, selection.faces[0], preview);
	} else if (BarItems.selection_mode.value === 'edge' && selection.edges.length === 1) {
		startEdgeExtrude(event, cube, selection.edges[0], preview);
	}
}
