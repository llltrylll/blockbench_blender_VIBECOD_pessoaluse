import { THREE } from '../lib/libs';
import { Canvas } from '../preview/canvas';
import { Mesh, MeshFace } from '../outliner/types/mesh';
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
		const source_face_key = faceKeyForAxis(source_axis, source_sign);
		const source_normal = [0, 0, 0];
		source_normal[source_axis] = source_sign;
		const source_normal_world = new THREE.Vector3(...source_normal).transformDirection(cube.mesh.matrixWorld).normalize();

		return {
			move_axis,
			local_normal,
			world_normal,
			screen_direction: screen_axis.normalize(),
			pixels_per_unit,
			source_face: cube.faces[source_face_key],
			source_normal_world,
		};
	}).filter(candidate => candidate.pixels_per_unit > 0.1 && Number.isFinite(candidate.pixels_per_unit) && candidate.source_face);
}

function getEdgeQuadWorldPositions(context, amount) {
	const [a, b] = context.edge.map(Number);
	const base_a = context.world_vertices[a].clone();
	const base_b = context.world_vertices[b].clone();
	const offset = context.candidate.world_normal.clone().multiplyScalar(amount);
	const extruded_a = base_a.clone().add(offset);
	const extruded_b = base_b.clone().add(offset);

	const normal = new THREE.Vector3().crossVectors(
		base_b.clone().sub(base_a),
		extruded_a.clone().sub(base_a)
	).normalize();
	if (normal.dot(context.candidate.source_normal_world) < 0) {
		return [base_b, base_a, extruded_a, extruded_b];
	}
	return [base_a, base_b, extruded_b, extruded_a];
}

function getMeshLocalPoint(world_point, context) {
	return world_point.clone()
		.applyMatrix4(context.parent_inverse)
		.add(context.mesh_origin)
		.toArray();
}

function updateEdgeMesh(context, amount) {
	const world_points = getEdgeQuadWorldPositions(context, amount);
	if (!context.mesh) {
		const parent = context.parent;
		const mesh = new Mesh({
			name: context.cube.name + ' Edge Extrude',
			vertices: {},
			color: context.cube.color,
		});
		mesh.origin = context.mesh_origin.toArray();
		if (parent) mesh.addTo(parent);

		const keys = mesh.addVertices(...world_points.map(point => getMeshLocalPoint(point, context)));
		const edge_length = context.world_vertices[Number(context.edge[0])]
			.distanceTo(context.world_vertices[Number(context.edge[1])]);
		const uv = {
			[keys[0]]: [0, 0],
			[keys[1]]: [edge_length, 0],
			[keys[2]]: [edge_length, amount],
			[keys[3]]: [0, amount],
		};
		const texture = context.candidate.source_face.texture
			|| (Format.single_texture ? Texture.getDefault()?.uuid : false);
		const face = new MeshFace(mesh, {vertices: keys, uv, texture});
		const [face_key] = mesh.addFaces(face);
		mesh.init();

		context.mesh = mesh;
		context.mesh_vertex_keys = keys;
		context.mesh_face_key = face_key;
	} else {
		world_points.forEach((point, index) => {
			const local = getMeshLocalPoint(point, context);
			context.mesh.vertices[context.mesh_vertex_keys[index]].splice(0, 3, ...local);
		});
		const face = context.mesh.faces[context.mesh_face_key];
		const edge_length = context.world_vertices[Number(context.edge[0])]
			.distanceTo(context.world_vertices[Number(context.edge[1])]);
		face.uv[context.mesh_vertex_keys[0]] = [0, 0];
		face.uv[context.mesh_vertex_keys[1]] = [edge_length, 0];
		face.uv[context.mesh_vertex_keys[2]] = [edge_length, amount];
		face.uv[context.mesh_vertex_keys[3]] = [0, amount];
	}
	Mesh.preview_controller.updateAll(context.mesh);
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
	if (amount > 0.0001) updateEdgeMesh(context, amount);
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
		if (commit && context.mesh && context.amount > 0.0001) {
			unselectAllElements();
			context.mesh.select();
			const far_edge = [context.mesh_vertex_keys[2], context.mesh_vertex_keys[3]];
			context.mesh.getSelectedVertices(true).replace(far_edge);
			context.mesh.getSelectedEdges(true).replace([far_edge]);
			context.mesh.getSelectedFaces(true).empty();
			updateSelection();
			Canvas.updateView({
				elements: [context.mesh],
				element_aspects: {geometry: true, uv: true, faces: true, transform: true},
				selection: true,
			});
			Undo.finishEdit('Extrude Cube Edge');
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
		else if (pointer_event.button === 2) finishExtrude(false);
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

	const parent = cube.parent && cube.parent !== 'root' ? cube.parent : null;
	const parent_object = parent?.mesh || scene;
	parent_object.updateWorldMatrix(true, false);
	const parent_inverse = new THREE.Matrix4().copy(parent_object.matrixWorld).invert();
	const mesh_origin = Format.bone_rig && parent?.origin
		? new THREE.Vector3(...parent.origin)
		: new THREE.Vector3();

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
		parent,
		parent_inverse,
		mesh_origin,
		mesh: null,
		mesh_vertex_keys: [],
		mesh_face_key: null,
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
