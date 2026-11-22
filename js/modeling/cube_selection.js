import { THREE } from '../lib/libs';
import { getCubeComponentSelection } from './cube_selection_data';

export const CUBE_EDGE_INDICES = [
	[0, 1], [0, 2], [0, 5], [1, 3],
	[1, 4], [2, 3], [2, 7], [3, 6],
	[4, 5], [4, 6], [5, 7], [6, 7],
].map(edge => edge.map(String));

export function sameCubeEdge(a, b) {
	return !!a && !!b && a.length === 2 && b.length === 2
		&& ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]));
}

const OVERLAY_NAME = 'cube_component_selection_overlay';
const marker_geometry = new THREE.SphereGeometry(0.16, 10, 8);
const vertex_material = new THREE.MeshBasicMaterial({
	color: 0xffc44d,
	depthTest: false,
	depthWrite: false,
	toneMapped: false,
});
const edge_material = new THREE.LineBasicMaterial({
	color: 0xffc44d,
	depthTest: false,
	depthWrite: false,
	toneMapped: false,
});
const face_material = new THREE.MeshBasicMaterial({
	color: 0xffc44d,
	side: THREE.DoubleSide,
	transparent: true,
	opacity: 0.25,
	depthTest: true,
	depthWrite: false,
	polygonOffset: true,
	polygonOffsetFactor: -1,
	polygonOffsetUnits: -1,
	toneMapped: false,
});

function removeOverlay(cube) {
	const mesh = cube.mesh;
	if (!mesh) return;
	const old = mesh.getObjectByName(OVERLAY_NAME);
	if (old) {
		old.parent?.remove(old);
		old.traverse(child => {
			if (child.geometry && child.geometry !== marker_geometry) child.geometry.dispose();
		});
	}
}

function getLocalVertices(cube) {
	const mesh = cube.mesh;
	if (!mesh) return [];
	mesh.updateWorldMatrix(true, false);
	const inverse = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
	const world_vertices = cube.getGlobalVertexPositions();
	return world_vertices.map(coords => {
		const point = new THREE.Vector3(...coords).add(scene.position);
		return point.applyMatrix4(inverse);
	});
}

export function updateCubeComponentOverlay(cube) {
	removeOverlay(cube);
	if (!Project || !cube?.selected || !Modes.edit || !BarItems.selection_mode || BarItems.selection_mode.value === 'object') return;

	const selection = getCubeComponentSelection(cube);
	if (!selection) return;

	const mode = BarItems.selection_mode.value;
	const selected_vertices = (mode === 'vertex' || mode === 'edge')
		? (selection.vertices || []).map(key => Number(key)).filter(key => Number.isInteger(key) && key >= 0 && key < 8)
		: [];
	const selected_edges = mode === 'edge' ? (selection.edges || []) : [];
	const selected_faces = (mode === 'face' || mode === 'cluster') ? (selection.faces || []) : [];
	if (!selected_vertices.length && !selected_edges.length && !selected_faces.length) return;

	const mesh = cube.mesh;
	if (!mesh) return;
	const local_vertices = getLocalVertices(cube);
	if (local_vertices.length !== 8) return;

	const group = new THREE.Group();
	group.name = OVERLAY_NAME;
	group.renderOrder = 10000;

	const marker_indices = new Set(selected_vertices);
	const line_positions = [];
	const face_positions = [];
	const face_indices = [];
	selected_faces.forEach(fkey => {
		const indices = cube.faces[fkey]?.getVertexIndices();
		if (!indices || indices.length !== 4) return;
		const offset = face_positions.length / 3;
		indices.forEach(index => {
			const point = local_vertices[index];
			if (!point) return;
			face_positions.push(point.x, point.y, point.z);
			marker_indices.add(index);
		});
		face_indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
		indices.forEach((index, i) => {
			const next = indices[i + 1] ?? indices[0];
			line_positions.push(local_vertices[index], local_vertices[next]);
		});
	});
	selected_edges.forEach(edge => {
		const a = Number(edge[0]);
		const b = Number(edge[1]);
		if (!Number.isInteger(a) || !Number.isInteger(b) || !local_vertices[a] || !local_vertices[b]) return;
		marker_indices.add(a);
		marker_indices.add(b);
		line_positions.push(local_vertices[a], local_vertices[b]);
	});

	if (face_positions.length) {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(face_positions, 3));
		geometry.setIndex(face_indices);
		geometry.computeVertexNormals();
		const face_mesh = new THREE.Mesh(geometry, face_material);
		face_mesh.renderOrder = 9999;
		face_mesh.raycast = () => {};
		group.add(face_mesh);
	}

	if (line_positions.length) {
		const geometry = new THREE.BufferGeometry().setFromPoints(line_positions);
		const lines = new THREE.LineSegments(geometry, edge_material);
		lines.renderOrder = 10000;
		lines.raycast = () => {};
		group.add(lines);
	}

	marker_indices.forEach(index => {
		const marker = new THREE.Mesh(marker_geometry, vertex_material);
		marker.position.copy(local_vertices[index]);
		marker.renderOrder = 10001;
		marker.raycast = () => {};
		group.add(marker);
	});

	group.traverse(child => {
		child.frustumCulled = false;
	});
	mesh.add(group);
}

const overlay_cubes = new Set();

export function updateCubeComponentOverlays() {
	if (!Project || !Cube) return;
	const selected_cubes = Cube.selected.slice();
	const selected_set = new Set(selected_cubes);

	overlay_cubes.forEach(cube => {
		if (!selected_set.has(cube)) {
			removeOverlay(cube);
			overlay_cubes.delete(cube);
		}
	});

	selected_cubes.forEach(cube => {
		updateCubeComponentOverlay(cube);
		const selection = getCubeComponentSelection(cube);
		const mode = BarItems.selection_mode?.value;
		if (Modes.edit && mode !== 'object' && selection && (
			(mode === 'vertex' && selection.vertices?.length) ||
			(mode === 'edge' && selection.edges?.length) ||
			((mode === 'face' || mode === 'cluster') && selection.faces?.length)
		)) {
			overlay_cubes.add(cube);
		} else {
			overlay_cubes.delete(cube);
		}
	});
}

if (typeof Blockbench !== 'undefined') {
	Blockbench.on('update_selection', updateCubeComponentOverlays);
}
