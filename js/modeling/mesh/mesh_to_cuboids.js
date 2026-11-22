import { Dialog } from '../../interface/dialog';
import { THREE } from '../../lib/libs';
import { Cube } from '../../outliner/types/cube';
import { Mesh } from '../../outliner/types/mesh';

const EPSILON = 1e-6;
const FACE_DIRECTIONS = ['north', 'east', 'south', 'west', 'up', 'down'];
const DIRECTION_BY_AXIS = [
	['west', 'east'],
	['down', 'up'],
	['north', 'south'],
];

function add(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function subtract(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function multiply(a, scalar) {
	return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}
function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
function length(a) {
	return Math.sqrt(dot(a, a));
}
function normalize(a) {
	const len = length(a);
	return len > EPSILON ? multiply(a, 1 / len) : [0, 0, 0];
}
function average(points) {
	if (!points.length) return [0, 0, 0];
	return multiply(points.reduce((sum, point) => add(sum, point), [0, 0, 0]), 1 / points.length);
}
function textureId(face) {
	const texture = face.getTexture();
	if (texture && texture.uuid) return texture.uuid;
	return typeof face.texture === 'string' ? face.texture : false;
}
function createParentSpaceTransform(mesh) {
	const object = mesh.mesh;
	if (!object) throw new Error('A Mesh selecionada não possui objeto de visualização.');
	object.updateWorldMatrix(true, false);
	const parentObject = object.parent;
	return position => {
		const point = new THREE.Vector3(position[0], position[1], position[2]);
		object.localToWorld(point);
		if (parentObject) parentObject.worldToLocal(point);
		return point.toArray();
	};
}
function getFaceGeometry(mesh, face, transform) {
	if (!face || face.vertices.length < 3) return null;
	const keys = face.vertices.length === 4 ? face.getSortedVertices() : face.vertices.slice();
	if (keys.length < 3 || keys.some(key => !mesh.vertices[key])) return null;
	const positions = keys.map(key => transform(mesh.vertices[key]));
	if (positions.some(point => !point.every(Number.isFinite))) return null;

	// Newell normal supports planar triangles and quads without assuming perfect rectangles.
	const normalVector = [0, 0, 0];
	for (let i = 0; i < positions.length; i++) {
		const a = positions[i];
		const b = positions[(i + 1) % positions.length];
		normalVector[0] += (a[1] - b[1]) * (a[2] + b[2]);
		normalVector[1] += (a[2] - b[2]) * (a[0] + b[0]);
		normalVector[2] += (a[0] - b[0]) * (a[1] + b[1]);
	}
	const twiceArea = length(normalVector);
	if (twiceArea < EPSILON) return null;
	return {
		face,
		keys,
		positions,
		normal: normalize(normalVector),
		area: twiceArea * 0.5,
		texture: textureId(face),
	};
}
function positionKey(point, tolerance) {
	return point.map(value => Math.round(value / tolerance)).join(',');
}
function getConnectedFaceComponents(faceGeometryByKey) {
	const allPoints = Array.from(faceGeometryByKey.values()).flatMap(geometry => geometry.positions);
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const point of allPoints) {
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], point[axis]);
			max[axis] = Math.max(max[axis], point[axis]);
		}
	}
	const snapTolerance = Math.max(1e-5, length(subtract(max, min)) * 1e-6);
	const edgeOwners = new Map();
	for (const [faceKey, geometry] of faceGeometryByKey) {
		const positions = geometry.positions;
		for (let i = 0; i < positions.length; i++) {
			const a = positionKey(positions[i], snapTolerance);
			const b = positionKey(positions[(i + 1) % positions.length], snapTolerance);
			const id = a < b ? a + '_' + b : b + '_' + a;
			if (!edgeOwners.has(id)) edgeOwners.set(id, []);
			edgeOwners.get(id).push(faceKey);
		}
	}
	const neighbors = new Map(Array.from(faceGeometryByKey.keys(), key => [key, new Set()]));
	for (const owners of edgeOwners.values()) {
		for (let i = 0; i < owners.length; i++) {
			for (let j = i + 1; j < owners.length; j++) {
				neighbors.get(owners[i]).add(owners[j]);
				neighbors.get(owners[j]).add(owners[i]);
			}
		}
	}
	const components = [];
	const visited = new Set();
	for (const faceKey of faceGeometryByKey.keys()) {
		if (visited.has(faceKey)) continue;
		const queue = [faceKey];
		const component = [];
		visited.add(faceKey);
		while (queue.length) {
			const current = queue.pop();
			component.push(faceGeometryByKey.get(current));
			for (const neighbor of neighbors.get(current)) {
				if (visited.has(neighbor)) continue;
				visited.add(neighbor);
				queue.push(neighbor);
			}
		}
		components.push(component);
	}
	return components;
}
function clusterFaceNormals(faceGeometries) {
	const clusters = [];
	const parallelThreshold = Math.cos(Math.degToRad(15));
	for (const geometry of faceGeometries) {
		let cluster = null;
		let bestDot = 0;
		for (const candidate of clusters) {
			const alignment = Math.abs(dot(candidate.normal, geometry.normal));
			if (alignment > parallelThreshold && alignment > bestDot) {
				cluster = candidate;
				bestDot = alignment;
			}
		}
		if (!cluster) {
			clusters.push({sum: multiply(geometry.normal, geometry.area), normal: geometry.normal.slice(), area: geometry.area});
		} else {
			const sign = dot(cluster.normal, geometry.normal) < 0 ? -1 : 1;
			cluster.sum = add(cluster.sum, multiply(geometry.normal, geometry.area * sign));
			cluster.normal = normalize(cluster.sum);
			cluster.area += geometry.area;
		}
	}
	return clusters.sort((a, b) => b.area - a.area);
}
function chooseBoxAxes(faceGeometries) {
	const clusters = clusterFaceNormals(faceGeometries);
	if (clusters.length < 3) return null;
	let best = null;
	const maxClusters = Math.min(clusters.length, 18);
	for (let i = 0; i < maxClusters; i++) {
		for (let j = i + 1; j < maxClusters; j++) {
			for (let k = j + 1; k < maxClusters; k++) {
				const d01 = Math.abs(dot(clusters[i].normal, clusters[j].normal));
				const d02 = Math.abs(dot(clusters[i].normal, clusters[k].normal));
				const d12 = Math.abs(dot(clusters[j].normal, clusters[k].normal));
				const orthogonalityError = d01 + d02 + d12;
				if (Math.max(d01, d02, d12) > 0.5) continue;
				const score = clusters[i].area + clusters[j].area + clusters[k].area - orthogonalityError * (clusters[i].area + clusters[j].area + clusters[k].area) * 0.25;
				if (!best || score > best.score) best = {i, j, k, score};
			}
		}
	}
	if (!best) return null;

	const axisX = normalize(clusters[best.i].normal);
	let axisY = subtract(clusters[best.j].normal, multiply(axisX, dot(clusters[best.j].normal, axisX)));
	axisY = normalize(axisY);
	let axisZ = normalize(cross(axisX, axisY));
	if (length(axisZ) < EPSILON) return null;
	if (dot(axisZ, clusters[best.k].normal) < 0) {
		axisY = multiply(axisY, -1);
		axisZ = multiply(axisZ, -1);
	}
	return [axisX, axisY, axisZ];
}
function fitSolidCuboid(component, tolerance) {
	const axes = chooseBoxAxes(component);
	if (!axes) return null;
	const allPositions = component.flatMap(geometry => geometry.positions);
	const minPoint = [Infinity, Infinity, Infinity];
	const maxPoint = [-Infinity, -Infinity, -Infinity];
	for (const point of allPositions) {
		for (let axis = 0; axis < 3; axis++) {
			minPoint[axis] = Math.min(minPoint[axis], point[axis]);
			maxPoint[axis] = Math.max(maxPoint[axis], point[axis]);
		}
	}
	const pointSnap = Math.max(1e-5, length(subtract(maxPoint, minPoint)) * 1e-6);
	const pointMap = new Map();
	for (const point of allPositions) pointMap.set(positionKey(point, pointSnap), point);
	const points = Array.from(pointMap.values());
	if (points.length < 8) return null;

	const projected = points.map(point => axes.map(axis => dot(point, axis)));
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const coords of projected) {
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], coords[axis]);
			max[axis] = Math.max(max[axis], coords[axis]);
		}
	}
	const size = max.map((value, axis) => value - min[axis]);
	if (size.some(value => value < EPSILON)) return null;
	const minimumSize = Math.min(...size);
	const allowedDeviation = minimumSize * tolerance;

	// A valid cuboid shell should keep most vertices close to one of its six planes.
	let nearBoundary = 0;
	for (const coords of projected) {
		const nearestPlaneDistance = Math.min(
			coords[0] - min[0], max[0] - coords[0],
			coords[1] - min[1], max[1] - coords[1],
			coords[2] - min[2], max[2] - coords[2]
		);
		if (nearestPlaneDistance <= allowedDeviation) nearBoundary++;
	}
	const boundaryRatio = nearBoundary / projected.length;

	let totalArea = 0;
	let alignedArea = 0;
	for (const geometry of component) {
		totalArea += geometry.area;
		const alignment = Math.max(...axes.map(axis => Math.abs(dot(axis, geometry.normal))));
		if (alignment >= Math.cos(Math.degToRad(30))) alignedArea += geometry.area;
	}
	const alignedAreaRatio = totalArea > EPSILON ? alignedArea / totalArea : 0;
	if (boundaryRatio < 0.78 || alignedAreaRatio < 0.58) return null;

	// Verify that all six sides have enough surface coverage. This prevents an L-shaped
	// or hollow shell from being collapsed into one oversized box just because its
	// vertices happen to touch the bounding planes.
	const sideCoverage = [[0, 0], [0, 0], [0, 0]];
	for (const geometry of component) {
		const alignmentByAxis = axes.map(axis => dot(axis, geometry.normal));
		let axisIndex = 0;
		for (let i = 1; i < 3; i++) {
			if (Math.abs(alignmentByAxis[i]) > Math.abs(alignmentByAxis[axisIndex])) axisIndex = i;
		}
		if (Math.abs(alignmentByAxis[axisIndex]) < Math.cos(Math.degToRad(30))) continue;
		const faceCenter = average(geometry.positions);
		const facePlane = dot(faceCenter, axes[axisIndex]);
		const midpoint = (min[axisIndex] + max[axisIndex]) * 0.5;
		const sideIndex = facePlane >= midpoint ? 1 : 0;
		const targetPlane = sideIndex ? max[axisIndex] : min[axisIndex];
		const planeTolerance = Math.max(allowedDeviation * 1.5, size[axisIndex] * 0.03);
		if (Math.abs(facePlane - targetPlane) <= planeTolerance) {
			sideCoverage[axisIndex][sideIndex] += geometry.area * Math.abs(alignmentByAxis[axisIndex]);
		}
	}
	const minimumSideCoverage = Math.max(0.55, 0.88 - tolerance * 0.8);
	for (let axis = 0; axis < 3; axis++) {
		const otherAxes = [0, 1, 2].filter(index => index !== axis);
		const expectedArea = size[otherAxes[0]] * size[otherAxes[1]];
		if (expectedArea < EPSILON) return null;
		for (let side = 0; side < 2; side++) {
			if (sideCoverage[axis][side] / expectedArea < minimumSideCoverage) return null;
		}
	}

	const mid = min.map((value, axis) => (value + max[axis]) * 0.5);
	const center = add(
		add(multiply(axes[0], mid[0]), multiply(axes[1], mid[1])),
		multiply(axes[2], mid[2])
	);
	const halfSize = size.map(value => value * 0.5);

	// Gather the best matching source texture/UV rectangle for each of the six box sides.
	const sides = {};
	for (const direction of FACE_DIRECTIONS) sides[direction] = {textures: new Map(), minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity, area: 0};
	for (const geometry of component) {
		const alignmentByAxis = axes.map(axis => dot(axis, geometry.normal));
		let axisIndex = 0;
		for (let i = 1; i < 3; i++) {
			if (Math.abs(alignmentByAxis[i]) > Math.abs(alignmentByAxis[axisIndex])) axisIndex = i;
		}
		if (Math.abs(alignmentByAxis[axisIndex]) < Math.cos(Math.degToRad(30))) continue;
		const faceCenter = average(geometry.positions);
		const facePlane = dot(faceCenter, axes[axisIndex]);
		const sign = facePlane >= (min[axisIndex] + max[axisIndex]) * 0.5 ? 1 : -1;
		const direction = DIRECTION_BY_AXIS[axisIndex][sign > 0 ? 1 : 0];
		const side = sides[direction];
		const faceCenter = average(geometry.positions);
		const facePlane = dot(faceCenter, axes[axisIndex]);
		const targetPlane = sign > 0 ? max[axisIndex] : min[axisIndex];
		if (Math.abs(facePlane - targetPlane) > Math.max(allowedDeviation * 1.5, size[axisIndex] * 0.03)) continue;
		const faceUVs = geometry.keys.map(key => geometry.face.uv && geometry.face.uv[key]).filter(uv => uv && Number.isFinite(uv[0]) && Number.isFinite(uv[1]));
		if (faceUVs.length >= 3) {
			for (const uv of faceUVs) {
				side.minU = Math.min(side.minU, uv[0]);
				side.minV = Math.min(side.minV, uv[1]);
				side.maxU = Math.max(side.maxU, uv[0]);
				side.maxV = Math.max(side.maxV, uv[1]);
			}
		}
		if (geometry.texture) side.textures.set(geometry.texture, (side.textures.get(geometry.texture) || 0) + geometry.area);
		side.area += geometry.area;
	}
	for (const direction of FACE_DIRECTIONS) {
		const side = sides[direction];
		side.texture = Array.from(side.textures.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || false;
		side.uv = [side.minU, side.minV, side.maxU, side.maxV].every(Number.isFinite) &&
			side.maxU > side.minU && side.maxV > side.minV
			? [side.minU, side.minV, side.maxU, side.maxV]
			: null;
	}

	return {center, axes, halfSize, sides, boundaryRatio, alignedAreaRatio};
}
function prepareMesh(mesh, options) {
	const transform = createParentSpaceTransform(mesh);
	const faceGeometryByKey = new Map();
	for (const faceKey in mesh.faces) {
		const geometry = getFaceGeometry(mesh, mesh.faces[faceKey], transform);
		if (geometry) faceGeometryByKey.set(faceKey, geometry);
	}
	const expectedFaceCount = Object.values(mesh.faces).filter(face => face.vertices.length >= 3).length;
	if (!faceGeometryByKey.size || faceGeometryByKey.size !== expectedFaceCount) {
		return {mesh, cuboids: [], rejected: 1, sourceFaces: expectedFaceCount};
	}

	const components = getConnectedFaceComponents(faceGeometryByKey);
	const cuboids = [];
	for (const component of components) {
		const cuboid = fitSolidCuboid(component, options.tolerance);
		if (!cuboid) {
			// Never hide a source Mesh if even one connected shell could not be fitted.
			return {mesh, cuboids: [], rejected: 1, sourceFaces: faceGeometryByKey.size};
		}
		cuboids.push(cuboid);
	}
	return {mesh, cuboids, rejected: 0, sourceFaces: faceGeometryByKey.size};
}
function makeCubeData(mesh, data, index) {
	const matrix = new THREE.Matrix4().makeBasis(
		new THREE.Vector3(...data.axes[0]),
		new THREE.Vector3(...data.axes[1]),
		new THREE.Vector3(...data.axes[2])
	);
	const euler = new THREE.Euler().setFromRotationMatrix(matrix, Format.euler_order);
	const center = data.center;
	const half = data.halfSize;
	const cube = new Cube({
		name: mesh.name + '_CPM_' + index,
		from: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
		to: [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
		origin: center.slice(),
		rotation: euler.toArray().slice(0, 3).map(Math.radToDeg),
		inflate: 0,
		stretch: [1, 1, 1],
		autouv: 0,
		box_uv: false,
		color: mesh.color,
		shade: true,
		export: mesh.export,
		visibility: true,
	});
	cube.box_uv = false;
	for (const direction of FACE_DIRECTIONS) {
		const face = cube.faces[direction];
		const side = data.sides[direction];
		face.enabled = true;
		face.texture = side.texture || false;
		if (side.uv) face.uv = side.uv.slice();
		face.rotation = 0;
	}
	return cube;
}
function convertMeshes(prepared, keepBackup, rejectedCount) {
	const sourceMeshes = prepared.map(entry => entry.mesh);
	Undo.initEdit({elements: sourceMeshes, outliner: true, selection: true});
	const created = [];
	try {
		for (const entry of prepared) {
			const mesh = entry.mesh;
			const originalName = mesh.name;
			const newCubes = [];
			entry.cuboids.forEach((cuboid, index) => {
				const cube = makeCubeData(mesh, cuboid, index + 1);
				cube.sortInBefore(mesh, 0).init();
				newCubes.push(cube);
			});
			created.push(...newCubes);
			if (keepBackup) {
				mesh.name = originalName + '_MESH_BACKUP';
				mesh.export = false;
				mesh.visibility = false;
				mesh.locked = true;
				if (mesh.mesh) mesh.mesh.visible = false;
			} else {
				mesh.remove();
			}
		}
		if (!created.length) {
			Undo.cancelEdit(true);
			Blockbench.showQuickMessage('Nenhum componente pôde ser ajustado como cuboid sólido. A Mesh foi mantida.', 5000);
			return;
		}
		Undo.finishEdit('Convert Mesh to Solid Cuboids', {elements: created, outliner: true, selection: true});
		updateSelection();
		if (created[0]) created[0].select();
		Canvas.updateView({
			elements: created.concat(keepBackup ? sourceMeshes : []),
			element_aspects: {geometry: true, transform: true, faces: true, uv: true},
			selection: true,
		});
		const cubeCount = prepared.reduce((sum, entry) => sum + entry.cuboids.length, 0);
		Blockbench.showQuickMessage(
			'Conversão concluída: ' + cubeCount + ' Cuboids sólidos. ' +
			rejectedCount + ' Mesh(es) não convertida(s) por não se ajustarem a volumes cúbicos. ' +
			(keepBackup ? 'Originais mantidos ocultos como backup.' : 'Originais substituídos.'),
			7000
		);
	} catch (error) {
		Undo.cancelEdit(true);
		updateSelection();
		Canvas.updateView({elements: sourceMeshes, element_aspects: {geometry: true, transform: true, faces: true, uv: true}, selection: true});
		Blockbench.showQuickMessage(error?.message || 'Falha ao converter Mesh para Cuboids.', 5000);
	}
}

new Action('mesh_to_cuboids', {
	name: 'Convert Mesh to Solid Cuboids',
	description: 'Fit one volumetric Cuboid to each connected Mesh shell, allowing small bevels and imperfect quads.',
	icon: 'fa-cubes',
	category: 'edit',
	condition: () => Modes.edit && Mesh.selected.length > 0,
	click() {
		const dialog = new Dialog('mesh_to_cuboids', {
			title: 'Convert Mesh to Solid Cuboids',
			form: {
				tolerance: {
					label: 'Permitir desvio/bevel (%)',
					type: 'number',
					value: 15,
					min: 1,
					max: 40,
					step: 1,
				},
				keep_backup: {
					label: 'Manter Mesh original oculta como backup',
					type: 'checkbox',
					value: true,
				},
			},
			onConfirm(result) {
				const options = {
					tolerance: Math.max(1, Math.min(40, Number(result.tolerance) || 15)) / 100,
				};
				const meshes = Mesh.selected.slice();
				let prepared;
				try {
					prepared = meshes.map(mesh => prepareMesh(mesh, options));
				} catch (error) {
					Blockbench.showQuickMessage(error?.message || 'Não foi possível analisar a Mesh.', 5000);
					return;
				}
				const valid = prepared.filter(entry => entry.cuboids.length > 0);
				const rejected = prepared.length - valid.length;
				if (!valid.length) {
					Blockbench.showQuickMessage('Nenhuma Mesh parece formar um volume cúbico. Nada foi alterado.', 6000);
					return;
				}
				convertMeshes(valid, result.keep_backup !== false, rejected);
			},
		});
		dialog.show();
	},
});