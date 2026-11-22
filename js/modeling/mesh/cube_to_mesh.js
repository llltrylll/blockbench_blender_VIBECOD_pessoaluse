import { THREE } from '../../lib/libs';
import { Mesh, MeshFace } from '../../outliner/types/mesh';
import { adjustFromAndToForInflateAndStretch } from '../../outliner/types/cube';

// Keep the same vertex order as Blockbench's native Convert to Mesh action.
// Bevel uses that order to translate Cube edge selections to mesh edge keys.
export function convertCubeToMesh(cube) {
	const mesh = new Mesh({
		name: cube.name,
		color: cube.color,
		origin: cube.origin,
		rotation: cube.rotation,
		vertices: []
	});

	const rotation = new THREE.Euler(0, 0, 0, Format.euler_order)
		.fromArray(cube.rotation.map(Math.degToRad));
	rotation.reorder('XYZ');
	mesh.rotation.V3_set(rotation.toArray().map(r => Math.roundTo(Math.radToDeg(r), 4)));

	const from = cube.from.slice();
	const to = cube.to.slice();
	adjustFromAndToForInflateAndStretch(from, to, cube);
	for (let i = 0; i < 3; i++) {
		from[i] -= cube.origin[i];
		to[i] -= cube.origin[i];
	}

	const vertexKeys = [
		mesh.addVertices([to[0], to[1], to[2]])[0],
		mesh.addVertices([to[0], to[1], from[2]])[0],
		mesh.addVertices([to[0], from[1], to[2]])[0],
		mesh.addVertices([to[0], from[1], from[2]])[0],
		mesh.addVertices([from[0], to[1], to[2]])[0],
		mesh.addVertices([from[0], to[1], from[2]])[0],
		mesh.addVertices([from[0], from[1], to[2]])[0],
		mesh.addVertices([from[0], from[1], from[2]])[0],
	];

	const unusedVertices = vertexKeys.slice();
	function addFace(direction, vertices) {
		const cubeFace = cube.faces[direction];
		if (!cubeFace || cubeFace.texture === null) return;

		const uvPoints = [
			[cubeFace.uv[0], cubeFace.uv[1]],
			[cubeFace.uv[2], cubeFace.uv[1]],
			[cubeFace.uv[2], cubeFace.uv[3]],
			[cubeFace.uv[0], cubeFace.uv[3]]
		];
		let rotation = cubeFace.rotation || 0;
		while (rotation > 0) {
			rotation -= 90;
			uvPoints.splice(0, 0, uvPoints.pop());
		}
		const uv = {
			[vertices[0]]: uvPoints[1],
			[vertices[1]]: uvPoints[0],
			[vertices[2]]: uvPoints[2],
			[vertices[3]]: uvPoints[3],
		};
		mesh.addFaces(new MeshFace(mesh, {
			vertices,
			uv,
			texture: cubeFace.texture,
		}));
		vertices.forEach(key => unusedVertices.remove(key));
	}

	addFace('east', [vertexKeys[1], vertexKeys[0], vertexKeys[3], vertexKeys[2]]);
	addFace('west', [vertexKeys[4], vertexKeys[5], vertexKeys[6], vertexKeys[7]]);
	addFace('up', [vertexKeys[1], vertexKeys[5], vertexKeys[0], vertexKeys[4]]);
	addFace('down', [vertexKeys[2], vertexKeys[6], vertexKeys[3], vertexKeys[7]]);
	addFace('south', [vertexKeys[0], vertexKeys[4], vertexKeys[2], vertexKeys[6]]);
	addFace('north', [vertexKeys[5], vertexKeys[1], vertexKeys[7], vertexKeys[3]]);

	unusedVertices.forEach(key => {
		delete mesh.vertices[key];
	});

	mesh.sortInBefore(cube).init();
	selected.push(mesh);
	cube.remove();
	return {mesh, vertexKeys};
}
