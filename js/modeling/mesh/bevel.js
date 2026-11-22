import { THREE } from '../../lib/libs';
import { MeshFace } from '../../outliner/types/mesh';
import { getCubeComponentSelection } from '../cube_selection_data';
import { convertCubeToMesh } from './cube_to_mesh';

const EPSILON = 1e-7;
const POSITION_PRECISION = 1e6;

function add(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function subtract(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function multiply(a, factor) {
	return [a[0] * factor, a[1] * factor, a[2] * factor];
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
	const magnitude = length(a);
	if (magnitude < EPSILON) return [0, 0, 0];
	return multiply(a, 1 / magnitude);
}
function distanceSquared(a, b) {
	return dot(subtract(a, b), subtract(a, b));
}
function average(points) {
	const result = [0, 0, 0];
	points.forEach(point => {
		result[0] += point[0];
		result[1] += point[1];
		result[2] += point[2];
	});
	return points.length ? multiply(result, 1 / points.length) : result;
}
function edgeId(a, b) {
	return a < b ? a + '|' + b : b + '|' + a;
}
function uniqueEdges(edges) {
	const result = [];
	const seen = new Set();
	(edges || []).forEach(edge => {
		if (!edge || edge.length !== 2) return;
		const pair = [String(edge[0]), String(edge[1])];
		if (pair[0] === pair[1]) return;
		const id = edgeId(pair[0], pair[1]);
		if (seen.has(id)) return;
		seen.add(id);
		result.push(pair);
	});
	return result;
}
function createPointFactory() {
	const generatedIds = new Map();
	let counter = 0;
	return {
		generated(position) {
			const id = position.map(value => Math.round(value * POSITION_PRECISION)).join(',');
			if (!generatedIds.has(id)) generatedIds.set(id, 'bevel:' + counter++);
			return generatedIds.get(id);
		},
		original(key) {
			return 'vertex:' + key;
		}
	};
}
function makeOriginalPoint(key, position, uv, factory) {
	return {
		id: factory.original(key),
		originalKey: key,
		position: position.slice(),
		uv: uv ? uv.slice() : [0, 0],
	};
}
function makeGeneratedPoint(position, uv, factory) {
	return {
		id: factory.generated(position),
		position: position.slice(),
		uv: uv ? uv.slice() : [0, 0],
	};
}
function interpolatePoint(a, b, amount, factory) {
	if (amount <= EPSILON) return {...a, position: a.position.slice(), uv: a.uv.slice()};
	if (amount >= 1 - EPSILON) return {...b, position: b.position.slice(), uv: b.uv.slice()};
	const position = [
		a.position[0] + (b.position[0] - a.position[0]) * amount,
		a.position[1] + (b.position[1] - a.position[1]) * amount,
		a.position[2] + (b.position[2] - a.position[2]) * amount,
	];
	const uv = [
		a.uv[0] + (b.uv[0] - a.uv[0]) * amount,
		a.uv[1] + (b.uv[1] - a.uv[1]) * amount,
	];
	return makeGeneratedPoint(position, uv, factory);
}
function cleanPolygon(points) {
	const result = [];
	points.forEach(point => {
		const previous = result[result.length - 1];
		if (!previous || distanceSquared(previous.position, point.position) > EPSILON * EPSILON) {
			result.push(point);
		}
	});
	if (result.length > 2 && distanceSquared(result[0].position, result[result.length - 1].position) <= EPSILON * EPSILON) {
		result.pop();
	}
	return result;
}
function clipPolygon(points, plane, width, factory) {
	const output = [];
	if (!points.length) return output;
	const previousStart = points[points.length - 1];
	let previous = previousStart;
	let previousDistance = dot(subtract(previous.position, plane.origin), plane.inward) - width;
	let previousInside = previousDistance >= -EPSILON;
	for (const current of points) {
		const currentDistance = dot(subtract(current.position, plane.origin), plane.inward) - width;
		const currentInside = currentDistance >= -EPSILON;
		if (currentInside !== previousInside) {
			const denominator = previousDistance - currentDistance;
			const amount = Math.abs(denominator) < EPSILON ? 0.5 : Math.clamp(previousDistance / denominator, 0, 1);
			output.push(interpolatePoint(previous, current, amount, factory));
		}
		if (currentInside) output.push(current);
		previous = current;
		previousDistance = currentDistance;
		previousInside = currentInside;
	}
	return cleanPolygon(output);
}
function faceNormal(face) {
	const normal = face.getNormal(true);
	if (!normal || length(normal) < EPSILON) throw new Error('Uma das faces tem normal inválida.');
	return normal;
}
function validateFace(mesh, face, key) {
	const vertices = face.getSortedVertices();
	if (vertices.length < 3 || vertices.length > 4) {
		throw new Error('O bevel inicial aceita faces triangulares e quadrilaterais. Face incompatível: ' + key);
	}
	const positions = vertices.map(vertexKey => mesh.vertices[vertexKey]);
	if (positions.some(position => !position)) {
		throw new Error('A malha contém uma face com vértices ausentes.');
	}
	const normal = faceNormal(face);
	let longestEdge = 0;
	let turnSign = 0;
	for (let i = 0; i < positions.length; i++) {
		const a = positions[i];
		const b = positions[(i + 1) % positions.length];
		const c = positions[(i + 2) % positions.length];
		const edge = subtract(b, a);
		const nextEdge = subtract(c, b);
		const edgeLength = length(edge);
		longestEdge = Math.max(longestEdge, edgeLength);
		if (edgeLength < EPSILON) throw new Error('A malha contém uma aresta de comprimento zero.');
		const turn = dot(cross(edge, nextEdge), normal);
		if (Math.abs(turn) > EPSILON) {
			const sign = Math.sign(turn);
			if (turnSign && sign !== turnSign) {
				throw new Error('O bevel inicial não aceita faces côncavas ou cruzadas.');
			}
			turnSign = sign;
		}
	}
	if (vertices.length === 4) {
		const planeDistance = Math.abs(dot(subtract(positions[3], positions[0]), normal));
		if (planeDistance > Math.max(1, longestEdge) * 1e-4) {
			throw new Error('O bevel inicial exige faces planas.');
		}
	}
	return {vertices, positions, normal, longestEdge};
}
function analyzeMesh(mesh, requestedEdges) {
	const edges = uniqueEdges(requestedEdges);
	if (!edges.length) throw new Error('Selecione uma ou mais arestas antes de aplicar o bevel.');

	const adjacency = new Map();
	for (const faceKey in mesh.faces) {
		const face = mesh.faces[faceKey];
		if (face.vertices.length < 3) continue;
		const vertices = face.vertices.length === 4 ? face.getSortedVertices() : face.vertices;
		if (!vertices || vertices.length < 2) continue;
		for (let i = 0; i < vertices.length; i++) {
			const a = vertices[i];
			const b = vertices[(i + 1) % vertices.length];
			const id = edgeId(a, b);
			if (!adjacency.has(id)) adjacency.set(id, []);
			adjacency.get(id).push({faceKey, face, a, b});
		}
	}

	const selectedEdges = [];
	const faceClips = new Map();
	const faceData = new Map();
	let minimumEdgeLength = Infinity;
	for (const pair of edges) {
		const adjacent = adjacency.get(edgeId(pair[0], pair[1]));
		if (!adjacent || adjacent.length !== 2) {
			throw new Error('Cada aresta selecionada precisa pertencer a exatamente duas faces.');
		}
		const a = mesh.vertices[pair[0]];
		const b = mesh.vertices[pair[1]];
		if (!a || !b) throw new Error('Uma aresta selecionada perdeu um dos seus vértices.');
		if (length(subtract(b, a)) < EPSILON) throw new Error('Uma das arestas selecionadas tem comprimento zero.');

		selectedEdges.push({v0: pair[0], v1: pair[1], adjacent});
		adjacent.forEach(entry => {
			if (!faceData.has(entry.faceKey)) {
				faceData.set(entry.faceKey, validateFace(mesh, entry.face, entry.faceKey));
			}
			if (!faceClips.has(entry.faceKey)) faceClips.set(entry.faceKey, []);
			faceClips.get(entry.faceKey).push({v0: pair[0], v1: pair[1]});
			const info = faceData.get(entry.faceKey);
			minimumEdgeLength = Math.min(minimumEdgeLength, ...info.vertices.map((key, index) => {
				const next = info.vertices[(index + 1) % info.vertices.length];
				return length(subtract(mesh.vertices[next], mesh.vertices[key]));
			}));
		});
	}

	if (!Number.isFinite(minimumEdgeLength) || minimumEdgeLength < EPSILON) {
		throw new Error('Não foi possível calcular uma largura segura para o bevel.');
	}
	return {
		mesh,
		selectedEdges,
		faceClips,
		faceData,
		adjacency,
		minimumEdgeLength,
		maxWidth: minimumEdgeLength * 0.35,
	};
}
function pointOnSegmentParameter(position, a, b) {
	const direction = subtract(b, a);
	const lengthSquared = dot(direction, direction);
	if (lengthSquared < EPSILON * EPSILON) return null;
	const relative = subtract(position, a);
	const parameter = dot(relative, direction) / lengthSquared;
	const clamped = Math.clamp(parameter, 0, 1);
	const closest = add(a, multiply(direction, clamped));
	const tolerance = Math.max(1e-5, Math.sqrt(lengthSquared) * 1e-5);
	if (parameter < -1e-5 || parameter > 1 + 1e-5 || distanceSquared(position, closest) > tolerance * tolerance) {
		return null;
	}
	return clamped;
}
function makeFacePlans(analysis, width, factory) {
	const {mesh, faceClips, faceData, adjacency} = analysis;
	const plans = new Map();

	// First clip faces directly adjacent to selected edges. Keep every face
	// unmodified until all shared boundary points have been propagated.
	for (const [faceKey, clips] of faceClips.entries()) {
		const face = mesh.faces[faceKey];
		const info = faceData.get(faceKey);
		let polygon = info.vertices.map(key => makeOriginalPoint(key, mesh.vertices[key], face.uv[key], factory));
		for (const clip of clips) {
			const start = mesh.vertices[clip.v0];
			const end = mesh.vertices[clip.v1];
			const direction = normalize(subtract(end, start));
			let inward = normalize(cross(info.normal, direction));
			if (length(inward) < EPSILON) throw new Error('Não foi possível calcular a direção interna de uma aresta.');
			const center = average(info.positions);
			const midpoint = multiply(add(start, end), 0.5);
			if (dot(subtract(center, midpoint), inward) < 0) inward = multiply(inward, -1);
			polygon = clipPolygon(polygon, {origin: start, inward}, width, factory);
			if (polygon.length < 3) throw new Error('A largura escolhida eliminaria uma das faces.');
		}
		polygon = cleanPolygon(polygon);
		if (polygon.length < 3) throw new Error('O bevel produziria uma face degenerada.');
		plans.set(faceKey, {faceKey, face, info, polygon, cornerPoints: {}, cornerCapPoints: {}});
	}

	// A cut that reaches a shared original edge must also be inserted into
	// the neighboring face. Otherwise the bevel strip ends at a T-junction
	// and leaves a visible crack when only part of a cube is beveled.
	const edgeCuts = new Map();
	for (const plan of plans.values()) {
		for (let i = 0; i < plan.info.vertices.length; i++) {
			const aKey = plan.info.vertices[i];
			const bKey = plan.info.vertices[(i + 1) % plan.info.vertices.length];
			const a = mesh.vertices[aKey];
			const b = mesh.vertices[bKey];
			const id = edgeId(aKey, bKey);
			if (!edgeCuts.has(id)) {
				const forward = aKey < bKey;
				edgeCuts.set(id, {
					aKey: forward ? aKey : bKey,
					bKey: forward ? bKey : aKey,
					points: new Map(),
				});
			}
			const edge = edgeCuts.get(id);
			for (const point of plan.polygon) {
				const parameter = pointOnSegmentParameter(point.position, mesh.vertices[edge.aKey], mesh.vertices[edge.bKey]);
				if (parameter === null || parameter <= 1e-5 || parameter >= 1 - 1e-5) continue;
				if (!edge.points.has(point.id)) edge.points.set(point.id, {point, parameter});
			}
		}
	}

	for (const [id, edge] of edgeCuts.entries()) {
		if (!edge.points.size) continue;
		const candidates = Array.from(edge.points.values()).sort((a, b) => a.parameter - b.parameter);
		const adjacentFaces = adjacency.get(id) || [];
		for (const adjacent of adjacentFaces) {
			let plan = plans.get(adjacent.faceKey);
			if (!plan) {
				const info = validateFace(mesh, adjacent.face, adjacent.faceKey);
				const polygon = info.vertices.map(key => makeOriginalPoint(key, mesh.vertices[key], adjacent.face.uv[key], factory));
				plan = {faceKey: adjacent.faceKey, face: adjacent.face, info, polygon, cornerPoints: {}, cornerCapPoints: {}};
				plans.set(adjacent.faceKey, plan);
			}

			const edgeA = mesh.vertices[edge.aKey];
			const edgeB = mesh.vertices[edge.bKey];
			const expanded = [];
			for (let i = 0; i < plan.polygon.length; i++) {
				const current = plan.polygon[i];
				const next = plan.polygon[(i + 1) % plan.polygon.length];
				expanded.push(current);
				const currentT = pointOnSegmentParameter(current.position, edgeA, edgeB);
				const nextT = pointOnSegmentParameter(next.position, edgeA, edgeB);
				if (currentT === null || nextT === null || Math.abs(nextT - currentT) < 1e-5) continue;

				const low = Math.min(currentT, nextT);
				const high = Math.max(currentT, nextT);
				const insertions = candidates.filter(candidate =>
					candidate.parameter > low + 1e-5 && candidate.parameter < high - 1e-5
				);
				if (nextT < currentT) insertions.reverse();
				for (const insertion of insertions) {
					const position = insertion.point.position;
					const uv = plan.face.localToUV(
						new THREE.Vector3(position[0], position[1], position[2]),
						plan.info.vertices
					).toArray();
					expanded.push({...insertion.point, position: position.slice(), uv});
				}
			}
			plan.polygon = cleanPolygon(expanded);
		}
	}

	// If two clipped boundary edges meet at an otherwise untouched corner,
	// remove the original corner from the neighboring face. It becomes part
	// of the small corner patch instead of overlapping the bevel end cap.
	for (const plan of plans.values()) {
		for (let i = 0; i < plan.info.vertices.length; i++) {
			const vertexKey = plan.info.vertices[i];
			const previousKey = plan.info.vertices[(i + plan.info.vertices.length - 1) % plan.info.vertices.length];
			const nextKey = plan.info.vertices[(i + 1) % plan.info.vertices.length];
			const vertex = mesh.vertices[vertexKey];
			const radius = width * 1.75 + EPSILON;
			const previousCuts = edgeCuts.get(edgeId(previousKey, vertexKey));
			const nextCuts = edgeCuts.get(edgeId(vertexKey, nextKey));
			const previousHit = previousCuts && Array.from(previousCuts.points.values()).some(cut =>
				distanceSquared(cut.point.position, vertex) <= radius * radius
			);
			const nextHit = nextCuts && Array.from(nextCuts.points.values()).some(cut =>
				distanceSquared(cut.point.position, vertex) <= radius * radius
			);
			if (!previousHit || !nextHit) continue;

			const originalIndex = plan.polygon.findIndex(point => point.originalKey === vertexKey);
			if (originalIndex !== -1) {
				const [originalPoint] = plan.polygon.splice(originalIndex, 1);
				plan.cornerCapPoints[vertexKey] = originalPoint;
				plan.polygon = cleanPolygon(plan.polygon);
			}
		}
	}

	// Calculate the closest point to each original corner after propagation.
	// Bevel edge profiles need one endpoint on each adjacent original face.
	for (const plan of plans.values()) {
		for (const vertexKey of plan.info.vertices) {
			const vertex = mesh.vertices[vertexKey];
			let closest = null;
			let nearestDistance = Infinity;
			for (const point of plan.polygon) {
				const distance = distanceSquared(point.position, vertex);
				if (distance < nearestDistance) {
					nearestDistance = distance;
					closest = point;
				}
			}
			if (!closest || nearestDistance > Math.pow(width * 5 + EPSILON, 2)) {
				throw new Error('O recorte de uma face ficou ambíguo perto de um vértice.');
			}
			plan.cornerPoints[vertexKey] = closest;
		}
	}
	return plans;
}
function rotateAroundAxis(vector, axis, angle) {
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	return add(
		add(multiply(vector, cosine), multiply(cross(axis, vector), sine)),
		multiply(axis, dot(axis, vector) * (1 - cosine))
	);
}
function makeEdgeProfile(mesh, vertexKey, facePointA, facePointB, axis, segments, factory) {
	const origin = mesh.vertices[vertexKey];
	const vectorA = subtract(facePointA.position, origin);
	const vectorB = subtract(facePointB.position, origin);
	const axialA = dot(vectorA, axis);
	const axialB = dot(vectorB, axis);
	const radialA = subtract(vectorA, multiply(axis, axialA));
	const radialB = subtract(vectorB, multiply(axis, axialB));
	const radiusA = length(radialA);
	const radiusB = length(radialB);
	if (radiusA < EPSILON || radiusB < EPSILON) {
		throw new Error('Não foi possível construir o perfil do bevel em um dos vértices.');
	}
	const directionA = normalize(radialA);
	const directionB = normalize(radialB);
	const angle = Math.atan2(dot(axis, cross(directionA, directionB)), Math.clamp(dot(directionA, directionB), -1, 1));
	if (Math.abs(angle) < 1e-4) {
		throw new Error('Arestas entre faces coplanares não podem receber este bevel.');
	}
	const profile = [];
	for (let i = 0; i <= segments; i++) {
		const t = i / segments;
		if (i === 0) {
			profile.push(facePointA);
		} else if (i === segments) {
			profile.push(facePointB);
		} else {
			const direction = rotateAroundAxis(directionA, axis, angle * t);
			const axial = axialA + (axialB - axialA) * t;
			const radius = radiusA + (radiusB - radiusA) * t;
			const position = add(add(origin, multiply(axis, axial)), multiply(direction, radius));
			profile.push(makeGeneratedPoint(position, [0, 0], factory));
		}
	}
	return profile;
}
function makeEdgeWorks(analysis, facePlans, segments, factory) {
	const works = [];
	for (const edge of analysis.selectedEdges) {
		const adjacentA = edge.adjacent[0];
		const adjacentB = edge.adjacent[1];
		const planA = facePlans.get(adjacentA.faceKey);
		const planB = facePlans.get(adjacentB.faceKey);
		if (!planA || !planB) throw new Error('Não foi possível localizar as duas faces de uma aresta selecionada.');
		const pointA0 = planA.cornerPoints[edge.v0];
		const pointB0 = planB.cornerPoints[edge.v0];
		const pointA1 = planA.cornerPoints[edge.v1];
		const pointB1 = planB.cornerPoints[edge.v1];
		const axis = normalize(subtract(analysis.mesh.vertices[edge.v1], analysis.mesh.vertices[edge.v0]));
		if (length(axis) < EPSILON) throw new Error('Uma das arestas selecionadas tem direção inválida.');
		works.push({
			edge,
			faceA: planA,
			faceB: planB,
			profile0: makeEdgeProfile(analysis.mesh, edge.v0, pointA0, pointB0, axis, segments, factory),
			profile1: makeEdgeProfile(analysis.mesh, edge.v1, pointA1, pointB1, axis, segments, factory),
		});
	}
	return works;
}
function makeCornerWorks(mesh, facePlans, edgeWorks, width) {
	const edgeProfilesByVertex = new Map();
	edgeWorks.forEach(work => {
		[[work.edge.v0, work.profile0], [work.edge.v1, work.profile1]].forEach(([vertexKey, profile]) => {
			if (!edgeProfilesByVertex.has(vertexKey)) edgeProfilesByVertex.set(vertexKey, []);
			edgeProfilesByVertex.get(vertexKey).push(profile);
		});
	});

	const corners = [];
	for (const [vertexKey, profiles] of edgeProfilesByVertex.entries()) {
		// One selected edge at a three-face corner uses Blender's vertex-
		// deletion termination: the terminal face is trimmed and its new
		// boundary follows the bevel profile. No overlapping cap is added.
		if (profiles.length === 1) {
			const profile = profiles[0];
			const startPoint = profile[0];
			const endPoint = profile[profile.length - 1];
			let terminalFaceMarkerFound = false;
			let terminalFaceFound = false;
			for (const plan of facePlans.values()) {
				if (!plan.cornerCapPoints[vertexKey]) continue;
				terminalFaceMarkerFound = true;
				const polygon = plan.polygon;
				const hasProfileEdge = polygon.some((point, index) => {
					const next = polygon[(index + 1) % polygon.length];
					return (point.id === startPoint.id && next.id === endPoint.id) ||
						(point.id === endPoint.id && next.id === startPoint.id);
				});
				if (!hasProfileEdge) continue;

				const planeOrigin = plan.info.positions[0];
				const tolerance = Math.max(1e-4, width * 1e-3);
				const profilePoints = profile.slice(1, -1);
				for (const point of profile) {
					const distanceToPlane = Math.abs(dot(subtract(point.position, planeOrigin), plan.info.normal));
					if (distanceToPlane > tolerance) {
						throw new Error('O acabamento desta aresta exigiria uma face terminal não plana. Reduza a largura ou use segmentos 1.');
					}
				}
				const projectedProfile = profilePoints.map(point => ({
					...point,
					uv: plan.face.localToUV(
						new THREE.Vector3(point.position[0], point.position[1], point.position[2]),
						plan.info.vertices
					).toArray(),
				}));
				const corrected = [];
				for (let i = 0; i < polygon.length; i++) {
					const current = polygon[i];
					const next = polygon[(i + 1) % polygon.length];
					corrected.push(current);
					if (current.id === startPoint.id && next.id === endPoint.id) {
						corrected.push(...projectedProfile);
					} else if (current.id === endPoint.id && next.id === startPoint.id) {
						corrected.push(...projectedProfile.slice().reverse());
					}
				}
				plan.polygon = cleanPolygon(corrected);
				terminalFaceFound = true;
				break;
			}
			if (terminalFaceMarkerFound && !terminalFaceFound) {
				throw new Error('Não foi possível conectar o final do bevel à face vizinha.');
			}
			// If there is no third face (open mesh boundary), leave the
			// bevel profile open just as the source mesh boundary is open.
			if (!terminalFaceFound) continue;
			continue;
		}

		const incidentFaces = [];
		const normalSum = [0, 0, 0];
		for (const faceKey in mesh.faces) {
			const face = mesh.faces[faceKey];
			if (!face.vertices.includes(vertexKey) || face.vertices.length < 3) continue;
			const plan = facePlans.get(faceKey);
			if (plan) {
				const cornerRadius = width * 1.75 + EPSILON;
				plan.polygon.forEach(point => {
					if (distanceSquared(point.position, mesh.vertices[vertexKey]) <= cornerRadius * cornerRadius) {
						incidentFaces.push({face, point});
					}
				});
			} else {
				incidentFaces.push({
					face,
					point: makeOriginalPoint(vertexKey, mesh.vertices[vertexKey], face.uv[vertexKey], {
						original: key => 'vertex:' + key
					})
				});
			}
			normalSum[0] += face.getNormal(true)[0];
			normalSum[1] += face.getNormal(true)[1];
			normalSum[2] += face.getNormal(true)[2];
		}

		const pointsById = new Map();
		incidentFaces.forEach(entry => pointsById.set(entry.point.id, entry.point));
		profiles.forEach(profile => profile.forEach(point => pointsById.set(point.id, point)));
		const boundary = Array.from(pointsById.values());
		// When two selected edges meet, their bevel strips can share one
		// boundary edge directly; that corner does not need an extra cap.
		// Open surface boundaries are also intentionally left open.
		if (boundary.length < 3) {
			if (boundary.length >= 2) continue;
			throw new Error('Não foi possível fechar o canto de uma aresta bevelada.');
		}

		const center = average(boundary.map(point => point.position));
		let outward = normalize(normalSum);
		if (length(outward) < EPSILON) {
			outward = normalize(subtract(mesh.vertices[vertexKey], average(Object.values(mesh.vertices))));
		}
		let reference = null;
		for (const point of boundary) {
			const relative = subtract(point.position, center);
			const projected = subtract(relative, multiply(outward, dot(relative, outward)));
			if (length(projected) > EPSILON) {
				reference = normalize(projected);
				break;
			}
		}
		if (!reference) throw new Error('Não foi possível orientar o fechamento de um canto.');
		const secondAxis = normalize(cross(outward, reference));
		boundary.sort((a, b) => {
			const relativeA = subtract(a.position, center);
			const relativeB = subtract(b.position, center);
			const angleA = Math.atan2(dot(relativeA, secondAxis), dot(relativeA, reference));
			const angleB = Math.atan2(dot(relativeB, secondAxis), dot(relativeB, reference));
			return angleA - angleB;
		});

		corners.push({
			vertexKey,
			boundary,
			center,
			outward,
			referenceFace: incidentFaces[0]?.face,
		});
	}
	return corners;
}
function makePointUv(face, point) {
	const vertices = face.getSortedVertices();
	return face.localToUV(new THREE.Vector3(point.position[0], point.position[1], point.position[2]), vertices).toArray();
}
function faceNormalFromPoints(points) {
	if (points.length < 3) return [0, 0, 0];
	return normalize(cross(
		subtract(points[1].position, points[0].position),
		subtract(points[2].position, points[0].position)
	));
}
function makeMeshPlan(mesh, analysis, width, segments, factory) {
	const facePlans = makeFacePlans(analysis, width, factory);
	const edgeWorks = makeEdgeWorks(analysis, facePlans, segments, factory);
	const corners = makeCornerWorks(mesh, facePlans, edgeWorks, width);
	return {
		mesh,
		analysis,
		facePlans,
		edgeWorks,
		corners,
	};
}
function pointKey(point, keyMap, pointMap, mesh) {
	if (!keyMap.has(point.id)) {
		if (point.originalKey && mesh.vertices[point.originalKey]) {
			keyMap.set(point.id, point.originalKey);
		} else {
			const key = mesh.addVertices(point.position)[0];
			keyMap.set(point.id, key);
		}
		pointMap.set(point.id, point);
	}
	return keyMap.get(point.id);
}
function orientPoints(points, expectedNormal) {
	const result = points.slice();
	const normal = faceNormalFromPoints(result);
	if (dot(normal, expectedNormal) < 0) result.reverse();
	return result;
}
function createGeneratedFace(mesh, points, texture, uvSource, expectedNormal, keyMap, pointMap) {
	if (points.length < 3) return null;
	let ordered = orientPoints(points, expectedNormal);
	const vertexKeys = ordered.map(point => pointKey(point, keyMap, pointMap, mesh));
	if (new Set(vertexKeys).size !== vertexKeys.length) return null;
	const uv = {};
	ordered.forEach((point, index) => {
		const key = vertexKeys[index];
		uv[key] = makePointUv(uvSource, point);
	});
	const face = new MeshFace(mesh, {vertices: vertexKeys, uv, texture});
	mesh.addFaces(face);
	return face;
}
function applyMeshPlan(plan) {
	const {mesh, facePlans, edgeWorks, corners} = plan;
	const keyMap = new Map();
	const pointMap = new Map();
	const oldAffectedVertices = new Set();
	for (const facePlan of facePlans.values()) {
		facePlan.info.vertices.forEach(key => oldAffectedVertices.add(key));
	}

	const selectedRails = [];
	for (const work of edgeWorks) {
		const averageNormal = normalize(add(work.faceA.info.normal, work.faceB.info.normal));
		const expectedNormal = length(averageNormal) > EPSILON ? averageNormal : work.faceA.info.normal;
		for (let i = 0; i < work.profile0.length - 1; i++) {
			const quad = [
				work.profile0[i],
				work.profile1[i],
				work.profile1[i + 1],
				work.profile0[i + 1],
			];
			createGeneratedFace(mesh, quad, work.faceA.face.texture, work.faceA.face, expectedNormal, keyMap, pointMap);
		}
		for (let i = 0; i < work.profile0.length; i++) {
			const a = pointKey(work.profile0[i], keyMap, pointMap, mesh);
			const b = pointKey(work.profile1[i], keyMap, pointMap, mesh);
			if (a !== b) selectedRails.push([a, b]);
		}
	}

	for (const corner of corners) {
		const boundary = corner.boundary;
		if (boundary.length === 3) {
			createGeneratedFace(mesh, boundary, corner.referenceFace.texture, corner.referenceFace, corner.outward, keyMap, pointMap);
			continue;
		}
		const centerPoint = makeGeneratedPoint(corner.center, [0, 0], {
			generated(position) {
				return 'corner-center:' + corner.vertexKey;
			}
		});
		for (let i = 0; i < boundary.length; i++) {
			createGeneratedFace(
				mesh,
				[centerPoint, boundary[i], boundary[(i + 1) % boundary.length]],
				corner.referenceFace.texture,
				corner.referenceFace,
				corner.outward,
				keyMap,
				pointMap
			);
		}
	}


	for (const facePlan of facePlans.values()) {
		const keys = facePlan.polygon.map(point => pointKey(point, keyMap, pointMap, mesh));
		if (new Set(keys).size !== keys.length) throw new Error('O recorte gerou vértices duplicados em uma face.');
		const uv = {};
		facePlan.polygon.forEach((point, index) => {
			uv[keys[index]] = point.uv.slice();
		});
		if (keys.length <= 4) {
			facePlan.face.extend({vertices: keys, uv});
		} else {
			const faceData = facePlan.face.getSaveCopy();
			delete mesh.faces[facePlan.faceKey];
			for (let i = 1; i < keys.length - 1; i++) {
				const triangleKeys = [keys[0], keys[i], keys[i + 1]];
				const triangleUV = {
					[triangleKeys[0]]: uv[triangleKeys[0]],
					[triangleKeys[1]]: uv[triangleKeys[1]],
					[triangleKeys[2]]: uv[triangleKeys[2]],
				};
				const triangle = new MeshFace(mesh, faceData).extend({
					vertices: triangleKeys,
					uv: triangleUV,
				});
				mesh.addFaces(triangle);
			}
		}
	}

	const usedVertices = new Set();
	for (const faceKey in mesh.faces) {
		mesh.faces[faceKey].vertices.forEach(key => usedVertices.add(key));
	}
	oldAffectedVertices.forEach(key => {
		if (!usedVertices.has(key)) delete mesh.vertices[key];
	});

	plan.analysis.selectedEdges.forEach(edge => {
		delete mesh.seams[edge.v0 < edge.v1 ? edge.v0 + '_' + edge.v1 : edge.v1 + '_' + edge.v0];
	});
	mesh.getSelectedEdges(true).replace(uniqueEdges(selectedRails));
	mesh.getSelectedVertices(true).replace(Array.from(new Set(selectedRails.flat())));
	mesh.getSelectedFaces(true).empty();
	return mesh;
}
function createSnapshots() {
	const cubes = Cube.selected.map(cube => ({
		uuid: cube.uuid,
		edges: getCubeComponentSelection(cube).edges.map(edge => edge.slice()),
	})).filter(snapshot => snapshot.edges.length);
	const meshes = Mesh.selected.map(mesh => ({
		uuid: mesh.uuid,
		edges: mesh.getSelectedEdges().map(edge => edge.slice()),
	})).filter(snapshot => snapshot.edges.length);
	return {cubes, meshes};
}
function resolveSnapshots(snapshots) {
	const cubes = snapshots.cubes.map(snapshot => {
		const cube = Cube.all.find(element => element.uuid === snapshot.uuid);
		if (!cube) throw new Error('Não foi possível restaurar um dos cuboides selecionados.');
		return {cube, snapshot};
	});
	const meshes = snapshots.meshes.map(snapshot => {
		const mesh = Mesh.all.find(element => element.uuid === snapshot.uuid);
		if (!mesh) throw new Error('Não foi possível restaurar uma das malhas selecionadas.');
		return {mesh, snapshot};
	});
	return {cubes, meshes};
}
function runBevel(snapshots, amended, requestedWidth, requestedSegments) {
	let currentCubes = [];
	let currentMeshes = [];
	let editStarted = false;
	try {
		const resolved = resolveSnapshots(snapshots);
		currentCubes = resolved.cubes.map(entry => entry.cube);
		currentMeshes = resolved.meshes.map(entry => entry.mesh);
		const originalElements = currentCubes.concat(currentMeshes);
		Undo.initEdit({
			elements: originalElements,
			outliner: currentCubes.length > 0,
			selection: true,
		}, amended);
		editStarted = true;

		const targets = resolved.meshes.map(entry => {
			entry.mesh.getSelectedEdges(true).replace(entry.snapshot.edges);
			return {mesh: entry.mesh, edges: entry.snapshot.edges};
		});
		for (const entry of resolved.cubes) {
			const {mesh, vertexKeys} = convertCubeToMesh(entry.cube);
			const meshEdges = entry.snapshot.edges.map(edge => {
				// Cube component indices follow getGlobalVertexPositions(), while
				// the native Cube-to-Mesh converter uses a different order for 4-7.
				const cubeIndexToMeshIndex = [0, 1, 2, 3, 5, 4, 7, 6];
				const a = vertexKeys[cubeIndexToMeshIndex[Number(edge[0])]];
				const b = vertexKeys[cubeIndexToMeshIndex[Number(edge[1])]];
				if (!a || !b) throw new Error('Uma aresta do cuboide não pôde ser convertida para malha.');
				return [a, b];
			});
			mesh.getSelectedEdges(true).replace(meshEdges);
			mesh.getSelectedVertices(true).replace(Array.from(new Set(meshEdges.flat())));
			targets.push({mesh, edges: meshEdges});
		}

		if (!targets.length) throw new Error('Nenhuma aresta válida foi encontrada.');
		const analyses = targets.map(target => analyzeMesh(target.mesh, target.edges));
		const maximumWidth = Math.min(...analyses.map(analysis => analysis.maxWidth));
		const defaultWidth = Math.min(...analyses.map(analysis => analysis.minimumEdgeLength * 0.1));
		if (!(maximumWidth > EPSILON)) throw new Error('A malha é pequena demais para receber bevel.');
		const minimumWidth = Math.min(0.001, maximumWidth * 0.001);
		const width = requestedWidth == null
			? defaultWidth
			: Math.clamp(Number(requestedWidth), minimumWidth, maximumWidth);
		const segments = Math.clamp(Math.round(Number(requestedSegments) || 1), 1, 12);
		const plans = [];
		for (let i = 0; i < targets.length; i++) {
			const factory = createPointFactory();
			plans.push(makeMeshPlan(targets[i].mesh, analyses[i], width, segments, factory));
		}

		plans.forEach(plan => applyMeshPlan(plan));
		const affectedMeshes = targets.map(target => target.mesh);
		Undo.finishEdit('Bevel Edges', {
			elements: affectedMeshes,
			outliner: currentCubes.length > 0,
			selection: true,
		});
		updateSelection();
		Canvas.updateView({
			elements: affectedMeshes,
			element_aspects: {geometry: true, uv: true, faces: true},
			selection: true,
		});
		return {defaultWidth, maximumWidth, minimumWidth};
	} catch (error) {
		if (editStarted) {
			Undo.cancelEdit(true);
			if (Undo.current_selection_save) Undo.cancelSelection(true);
		}
		updateSelection();
		if (editStarted) Canvas.updateView({elements: currentMeshes, element_aspects: {geometry: true, uv: true, faces: true}, selection: true});
		Blockbench.showQuickMessage(error?.message || 'Não foi possível aplicar o bevel.', 4000);
		return null;
	}
}

new Action('bevel_edges', {
	name: 'Bevel',
	icon: 'fa-bezier-curve',
	category: 'edit',
	keybind: new Keybind({key: 'b', ctrl: true}),
	condition: () => Modes.edit && BarItems.selection_mode.value === 'edge' && (
		Mesh.selected.some(mesh => mesh.getSelectedEdges().length) ||
		Cube.selected.some(cube => getCubeComponentSelection(cube).edges.length)
	),
	click() {
		const snapshots = createSnapshots();
		if (!snapshots.cubes.length && !snapshots.meshes.length) return;
		const result = runBevel(snapshots, false, null, 1);
		if (!result) return;

		Undo.amendEdit({
			width: {
				type: 'num_slider',
				value: result.defaultWidth,
				min: result.minimumWidth,
				max: result.maximumWidth,
				label: 'Width',
				interval_type: 'position',
			},
			segments: {
				type: 'num_slider',
				value: 1,
				min: 1,
				max: 12,
				step: 1,
				force_step: true,
				label: 'Segments',
			},
		}, form => {
			runBevel(snapshots, true, form.width, form.segments);
		});
	}
});
