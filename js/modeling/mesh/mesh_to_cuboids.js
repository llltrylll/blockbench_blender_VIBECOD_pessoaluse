import { Dialog } from '../../interface/dialog';
import { THREE } from '../../lib/libs';
import { Cube } from '../../outliner/types/cube';
import { Mesh } from '../../outliner/types/mesh';

const EPSILON = 1e-6;
const FACE_DIRECTIONS = ['north', 'east', 'south', 'west', 'up', 'down'];

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
	const sum = points.reduce((result, point) => add(result, point), [0, 0, 0]);
	return multiply(sum, 1 / Math.max(1, points.length));
}
function distance(a, b) {
	return length(subtract(a, b));
}
function edgeId(a, b) {
	return a < b ? a + '_' + b : b + '_' + a;
}
function sameNumber(a, b, epsilon) {
	return Math.abs(a - b) <= epsilon;
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
function getUvCorners(keys, uv) {
	const values = keys.map(key => uv[key]);
	if (values.some(value => !value || !Number.isFinite(value[0]) || !Number.isFinite(value[1]))) return null;
	const minU = Math.min(...values.map(value => value[0]));
	const maxU = Math.max(...values.map(value => value[0]));
	const minV = Math.min(...values.map(value => value[1]));
	const maxV = Math.max(...values.map(value => value[1]));
	if (maxU - minU < EPSILON || maxV - minV < EPSILON) return null;
	const epsilon = Math.max(1e-4, Math.max(maxU - minU, maxV - minV) * 1e-5);
	const indices = {};
	for (let i = 0; i < values.length; i++) {
		const u = values[i][0];
		const v = values[i][1];
		let corner;
		if (sameNumber(u, minU, epsilon) && sameNumber(v, minV, epsilon)) corner = 'uv00';
		else if (sameNumber(u, maxU, epsilon) && sameNumber(v, minV, epsilon)) corner = 'uv10';
		else if (sameNumber(u, maxU, epsilon) && sameNumber(v, maxV, epsilon)) corner = 'uv11';
		else if (sameNumber(u, minU, epsilon) && sameNumber(v, maxV, epsilon)) corner = 'uv01';
		else return null;
		if (indices[corner] !== undefined) return null;
		indices[corner] = i;
	}
	if (Object.keys(indices).length !== 4) return null;
	return {indices, minU, maxU, minV, maxV};
}
function describeQuad(mesh, faceKey, face, transform, tolerance) {
	if (face.vertices.length !== 4) return null;
	const keys = face.getSortedVertices();
	if (keys.length !== 4 || new Set(keys).size !== 4) return null;
	const uvCorners = getUvCorners(keys, face.uv);
	if (!uvCorners) return null;
	const positions = keys.map(key => transform(mesh.vertices[key]));
	if (positions.some(position => !position.every(Number.isFinite))) return null;

	const p00 = positions[uvCorners.indices.uv00];
	const p10 = positions[uvCorners.indices.uv10];
	const p11 = positions[uvCorners.indices.uv11];
	const p01 = positions[uvCorners.indices.uv01];

	const edgeU0 = subtract(p10, p00);
	const edgeU1 = subtract(p11, p01);
	const edgeV0 = subtract(p01, p00);
	const edgeV1 = subtract(p11, p10);
	const axisU = normalize(add(normalize(edgeU0), normalize(edgeU1)));
	let axisV = normalize(add(normalize(edgeV0), normalize(edgeV1)));
	axisV = normalize(subtract(axisV, multiply(axisU, dot(axisV, axisU))));
	if (length(axisU) < EPSILON || length(axisV) < EPSILON) return null;

	const center = average(positions);
	const projectedU = positions.map(position => dot(subtract(position, center), axisU));
	const projectedV = positions.map(position => dot(subtract(position, center), axisV));
	const minU = Math.min(...projectedU);
	const maxU = Math.max(...projectedU);
	const minV = Math.min(...projectedV);
	const maxV = Math.max(...projectedV);
	const width = maxU - minU;
	const height = maxV - minV;
	if (width < EPSILON || height < EPSILON) return null;

	const idealByCorner = {
		uv00: add(center, add(multiply(axisU, minU), multiply(axisV, minV))),
		uv10: add(center, add(multiply(axisU, maxU), multiply(axisV, minV))),
		uv11: add(center, add(multiply(axisU, maxU), multiply(axisV, maxV))),
		uv01: add(center, add(multiply(axisU, minU), multiply(axisV, maxV))),
	};
	let rectError = 0;
	for (const corner of Object.keys(uvCorners.indices)) {
		const index = uvCorners.indices[corner];
		rectError = Math.max(rectError, distance(positions[index], idealByCorner[corner]));
	}
	const planeNormal = normalize(cross(axisU, axisV));
	const planeError = Math.max(...positions.map(position =>
		Math.abs(dot(subtract(position, p00), planeNormal))
	));
	const scale = Math.max(width, height);
	const allowedError = Math.max(1e-5, scale * tolerance);
	if (Math.max(rectError, planeError) > allowedError) return null;

	const ordered = keys.map(key => positions[keys.indexOf(key)]);
	const geometryNormal = normalize(cross(subtract(ordered[1], ordered[0]), subtract(ordered[2], ordered[0])));
	if (length(geometryNormal) < EPSILON) return null;

	return {
		faceKey,
		face,
		keys,
		positions,
		texture: textureId(face),
		axisU,
		axisV,
		planeNormal: geometryNormal,
		planePoint: p00,
		uv00Position: p00,
		uvBounds: {
			minU: uvCorners.minU,
			maxU: uvCorners.maxU,
			minV: uvCorners.minV,
			maxV: uvCorners.maxV,
		},
		width,
		height,
		scale,
		uvScaleU: (uvCorners.maxU - uvCorners.minU) / width,
		uvScaleV: (uvCorners.maxV - uvCorners.minV) / height,
	};
}
function compatibleCoplanarFaces(a, b, tolerance) {
	if (a.texture !== b.texture) return false;
	const angularTolerance = Math.max(0.5, Math.min(3, tolerance * 100));
	const minimumDot = Math.cos(Math.degToRad(angularTolerance));
	if (dot(a.planeNormal, b.planeNormal) < minimumDot) return false;
	const allowedPlaneDistance = Math.max(a.scale, b.scale) * Math.max(1e-5, tolerance * 1.5);
	for (const point of b.positions) {
		if (Math.abs(dot(subtract(point, a.planePoint), a.planeNormal)) > allowedPlaneDistance) return false;
	}
	return true;
}
function polygonArea2D(points) {
	let area = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		area += a[0] * b[1] - b[0] * a[1];
	}
	return Math.abs(area) * 0.5;
}
function tryBuildRectangularRegion(faces, tolerance) {
	if (!faces.length) return null;
	const base = faces[0];
	const axisU = base.axisU;
	const axisV = base.axisV;
	const origin = base.uv00Position;
	const planeTolerance = base.scale * Math.max(1e-5, tolerance * 1.5);
	let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
	const projectedFaces = [];
	let totalArea = 0;

	for (const face of faces) {
		if (face.texture !== base.texture) return null;
		if (dot(face.planeNormal, base.planeNormal) < Math.cos(Math.degToRad(3))) return null;
		const projected = [];
		for (let i = 0; i < face.positions.length; i++) {
			const point = face.positions[i];
			if (Math.abs(dot(subtract(point, origin), base.planeNormal)) > planeTolerance) return null;
			const relative = subtract(point, origin);
			const x = dot(relative, axisU);
			const y = dot(relative, axisV);
			projected.push([x, y]);
			minU = Math.min(minU, x);
			maxU = Math.max(maxU, x);
			minV = Math.min(minV, y);
			maxV = Math.max(maxV, y);

			const expectedU = base.uvBounds.minU + x * base.uvScaleU;
			const expectedV = base.uvBounds.minV + y * base.uvScaleV;
			const actualUV = face.face.uv[face.keys[i]];
			const uvTolerance = Math.max(0.08, Math.max(
				base.uvBounds.maxU - base.uvBounds.minU,
				base.uvBounds.maxV - base.uvBounds.minV
			) * 0.001);
			if (Math.abs(actualUV[0] - expectedU) > uvTolerance ||
				Math.abs(actualUV[1] - expectedV) > uvTolerance) return null;
		}
		projectedFaces.push({face, projected});
		totalArea += polygonArea2D(projected);
	}

	const width = maxU - minU;
	const height = maxV - minV;
	const boundingArea = width * height;
	if (width < EPSILON || height < EPSILON || boundingArea < EPSILON) return null;
	const areaTolerance = Math.max(0.005, tolerance * 2.0);
	if (Math.abs(totalArea - boundingArea) / boundingArea > areaTolerance) return null;

	// Confirm that the component boundary forms the four sides of one rectangle.
	const edgeCounts = new Map();
	const edgePositions = new Map();
	for (const face of faces) {
		const keys = face.keys;
		for (let i = 0; i < keys.length; i++) {
			const aKey = keys[i];
			const bKey = keys[(i + 1) % keys.length];
			const id = edgeId(aKey, bKey);
			edgeCounts.set(id, (edgeCounts.get(id) || 0) + 1);
			if (!edgePositions.has(id)) {
				const ai = face.keys.indexOf(aKey);
				const bi = face.keys.indexOf(bKey);
				edgePositions.set(id, [
					face.positions[ai],
					face.positions[bi],
				]);
			}
		}
	}
	const sideCoverage = {left: 0, right: 0, bottom: 0, top: 0};
	const borderTolerance = Math.max(1e-5, base.scale * Math.max(0.001, tolerance * 2.5));
	for (const [id, count] of edgeCounts) {
		if (count !== 1) continue;
		const pair = edgePositions.get(id);
		const a = subtract(pair[0], origin);
		const b = subtract(pair[1], origin);
		const ax = dot(a, axisU), ay = dot(a, axisV);
		const bx = dot(b, axisU), by = dot(b, axisV);
		if (Math.abs(ax - minU) <= borderTolerance && Math.abs(bx - minU) <= borderTolerance) {
			sideCoverage.left += Math.abs(by - ay);
		} else if (Math.abs(ax - maxU) <= borderTolerance && Math.abs(bx - maxU) <= borderTolerance) {
			sideCoverage.right += Math.abs(by - ay);
		} else if (Math.abs(ay - minV) <= borderTolerance && Math.abs(by - minV) <= borderTolerance) {
			sideCoverage.bottom += Math.abs(bx - ax);
		} else if (Math.abs(ay - maxV) <= borderTolerance && Math.abs(by - maxV) <= borderTolerance) {
			sideCoverage.top += Math.abs(bx - ax);
		} else {
			return null;
		}
	}
	const coverageTolerance = Math.max(borderTolerance * 2, Math.max(width, height) * tolerance * 2.5);
	if (Math.abs(sideCoverage.left - height) > coverageTolerance ||
		Math.abs(sideCoverage.right - height) > coverageTolerance ||
		Math.abs(sideCoverage.bottom - width) > coverageTolerance ||
		Math.abs(sideCoverage.top - width) > coverageTolerance) return null;

	const midpointU = (minU + maxU) * 0.5;
	const midpointV = (minV + maxV) * 0.5;
	const center = add(origin, add(multiply(axisU, midpointU), multiply(axisV, midpointV)));
	const uvRect = [
		base.uvBounds.minU + minU * base.uvScaleU,
		base.uvBounds.minV + minV * base.uvScaleV,
		base.uvBounds.minU + maxU * base.uvScaleU,
		base.uvBounds.minV + maxV * base.uvScaleV,
	];
	return {
		center,
		width,
		height,
		axisU,
		axisV,
		normal: base.planeNormal,
		texture: base.texture,
		uvRect,
		faceCount: faces.length,
	};
}
function makeFaceComponents(descriptors, tolerance) {
	const edgeOwners = new Map();
	for (const descriptor of descriptors) {
		for (let i = 0; i < descriptor.keys.length; i++) {
			const id = edgeId(descriptor.keys[i], descriptor.keys[(i + 1) % descriptor.keys.length]);
			if (!edgeOwners.has(id)) edgeOwners.set(id, []);
			edgeOwners.get(id).push(descriptor);
		}
	}
	const neighbors = new Map(descriptors.map(descriptor => [descriptor.faceKey, new Set()]));
	for (const owners of edgeOwners.values()) {
		if (owners.length !== 2) continue;
		const [a, b] = owners;
		if (compatibleCoplanarFaces(a, b, tolerance)) {
			neighbors.get(a.faceKey).add(b);
			neighbors.get(b.faceKey).add(a);
		}
	}
	const components = [];
	const visited = new Set();
	for (const descriptor of descriptors) {
		if (visited.has(descriptor.faceKey)) continue;
		const queue = [descriptor];
		const component = [];
		visited.add(descriptor.faceKey);
		while (queue.length) {
			const current = queue.pop();
			component.push(current);
			for (const neighbor of neighbors.get(current.faceKey)) {
				if (visited.has(neighbor.faceKey)) continue;
				visited.add(neighbor.faceKey);
				queue.push(neighbor);
			}
		}
		components.push({faces: component, neighbors});
	}
	return components;
}
function buildMinimalRegions(descriptors, mergeCoplanar, tolerance) {
	const regions = [];
	const components = mergeCoplanar
		? makeFaceComponents(descriptors, tolerance)
		: descriptors.map(face => ({faces: [face], neighbors: null}));
	for (const component of components) {
		const {faces, neighbors} = component;
		const completeRegion = tryBuildRectangularRegion(faces, tolerance);
		if (completeRegion) {
			regions.push(completeRegion);
			continue;
		}
		if (faces.length === 1 || !mergeCoplanar || faces.length > 256) {
			for (const face of faces) {
				const region = tryBuildRectangularRegion([face], tolerance);
				if (region) regions.push(region);
			}
			continue;
		}
		// Greedy rectangular partition: expand the largest available face
		// through adjacent quads only while the combined surface remains a rectangle.
		const remaining = new Set(faces);
		while (remaining.size) {
			const seed = Array.from(remaining).sort((a, b) => b.width * b.height - a.width * a.height)[0];
			let current = [seed];
			let currentRegion = tryBuildRectangularRegion(current, tolerance);
			remaining.delete(seed);
			while (true) {
				const candidates = new Set();
				for (const face of current) {
					for (const neighbor of neighbors.get(face.faceKey)) {
						if (remaining.has(neighbor)) candidates.add(neighbor);
					}
				}
				const sortedCandidates = Array.from(candidates).sort((a, b) => b.width * b.height - a.width * a.height);
				let accepted = false;
				for (const candidate of sortedCandidates) {
					const merged = tryBuildRectangularRegion(current.concat(candidate), tolerance);
					if (merged) {
						current.push(candidate);
						currentRegion = merged;
						remaining.delete(candidate);
						accepted = true;
						break;
					}
				}
				if (!accepted) break;
			}
			if (currentRegion) regions.push(currentRegion);
		}
	}
	return regions;
}
function makeCubeData(mesh, region, index) {
	const southNormal = normalize(cross(region.axisU, multiply(region.axisV, -1)));
	const isSouth = dot(region.normal, southNormal) >= 0;
	const basisX = isSouth ? region.axisU : multiply(region.axisU, -1);
	const basisY = multiply(region.axisV, -1);
	const basisZ = normalize(cross(basisX, basisY));
	const matrix = new THREE.Matrix4().makeBasis(
		new THREE.Vector3(...basisX),
		new THREE.Vector3(...basisY),
		new THREE.Vector3(...basisZ)
	);
	const euler = new THREE.Euler().setFromRotationMatrix(matrix, Format.euler_order);
	const center = region.center;
	const halfWidth = region.width * 0.5;
	const halfHeight = region.height * 0.5;
	const from = [center[0] - halfWidth, center[1] - halfHeight, center[2]];
	const to = [center[0] + halfWidth, center[1] + halfHeight, center[2]];
	const cube = new Cube({
		name: mesh.name + '_CPM_' + index,
		from,
		to,
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
	for (const direction of FACE_DIRECTIONS) {
		const face = cube.faces[direction];
		face.texture = null;
		face.enabled = false;
		face.uv = [];
		face.rotation = 0;
	}
	const activeFace = cube.faces[isSouth ? 'south' : 'north'];
	activeFace.texture = region.texture || false;
	activeFace.enabled = true;
	activeFace.uv = region.uvRect.slice();
	activeFace.rotation = 0;
	return cube;
}
function prepareMesh(mesh, options) {
	const transform = createParentSpaceTransform(mesh);
	const descriptors = [];
	let skipped = 0;
	for (const faceKey in mesh.faces) {
		const face = mesh.faces[faceKey];
		if (face.vertices.length !== 4) {
			if (face.vertices.length >= 3) skipped++;
			continue;
		}
		const descriptor = describeQuad(mesh, faceKey, face, transform, options.tolerance);
		if (descriptor) descriptors.push(descriptor);
		else skipped++;
	}
	if (!descriptors.length) {
		return {mesh, regions: [], skipped, sourceFaces: Object.keys(mesh.faces).length};
	}
	const regions = buildMinimalRegions(descriptors, options.mergeCoplanar, options.tolerance);
	return {
		mesh,
		regions,
		skipped,
		sourceFaces: Object.keys(mesh.faces).length,
	};
}
function convertMeshes(prepared, keepBackup) {
	const sourceMeshes = prepared.map(entry => entry.mesh);
	const originalSelection = sourceMeshes.slice();
	Undo.initEdit({
		elements: sourceMeshes,
		outliner: true,
		selection: true,
	});
	let created = [];
	try {
		for (const entry of prepared) {
			if (!entry.regions.length) continue;
			const mesh = entry.mesh;
			const originalName = mesh.name;
			const newCubes = [];
			entry.regions.forEach((region, index) => {
				const cube = makeCubeData(mesh, region, index + 1);
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
			Blockbench.showQuickMessage('Nenhuma face retangular compatível foi encontrada. A Mesh foi mantida.', 4000);
			return;
		}
		Undo.finishEdit('Convert Mesh to CPM Cuboids', {
			elements: created,
			outliner: true,
			selection: true,
		});
		updateSelection();
		if (created[0]) created[0].select();
		Canvas.updateView({
			elements: created.concat(keepBackup ? sourceMeshes : []),
			element_aspects: {geometry: true, transform: true, faces: true, uv: true},
			selection: true,
		});
		const skipped = prepared.reduce((sum, entry) => sum + entry.skipped, 0);
		const sourceCount = prepared.reduce((sum, entry) => sum + entry.sourceFaces, 0);
		Blockbench.showQuickMessage(
			'Conversão concluída: ' + created.length + ' Cuboids para ' +
			(sourceCount - skipped) + ' quads; ' + skipped +
			' faces incompatíveis. ' + (keepBackup ? 'Mesh original mantida oculta como backup.' : 'Mesh original substituída.'),
			6000
		);
	} catch (error) {
		Undo.cancelEdit(true);
		updateSelection();
		Canvas.updateView({elements: originalSelection, element_aspects: {geometry: true, transform: true, faces: true, uv: true}, selection: true});
		Blockbench.showQuickMessage(error?.message || 'Falha ao converter Mesh para Cuboids.', 5000);
	}
}

new Action('mesh_to_cuboids', {
	name: 'Convert Mesh to CPM Cuboids',
	description: 'Convert rectangular quad surfaces into native Cube elements, merging coplanar faces to reduce parts.',
	icon: 'fa-cubes',
	category: 'edit',
	condition: () => Modes.edit && Mesh.selected.length > 0,
	click() {
		const dialog = new Dialog('mesh_to_cuboids', {
			title: 'Convert Mesh to CPM Cuboids',
			form: {
				tolerance: {
					label: 'Quad fitting tolerance (%)',
					type: 'number',
					value: 2,
					min: 0,
					max: 10,
					step: 0.1,
				},
				merge_coplanar: {
					label: 'Merge adjacent coplanar quads into fewer Cuboids',
					type: 'checkbox',
					value: true,
				},
				keep_backup: {
					label: 'Keep original Mesh hidden as a backup',
					type: 'checkbox',
					value: true,
				},
			},
			onConfirm(result) {
				const options = {
					tolerance: Math.max(0, Math.min(10, Number(result.tolerance) || 0)) / 100,
					mergeCoplanar: result.merge_coplanar !== false,
				};
				const meshes = Mesh.selected.slice();
				let prepared;
				try {
					prepared = meshes.map(mesh => prepareMesh(mesh, options)).filter(entry => entry.regions.length);
				} catch (error) {
					Blockbench.showQuickMessage(error?.message || 'Não foi possível analisar a Mesh.', 5000);
					return;
				}
				if (!prepared.length) {
					Blockbench.showQuickMessage('Nenhuma face retangular compatível foi encontrada. Use quads planos com UVs retangulares.', 5000);
					return;
				}
				convertMeshes(prepared, result.keep_backup !== false);
			},
		});
		dialog.show();
	},
});
