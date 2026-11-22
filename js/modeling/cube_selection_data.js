const selections = new WeakMap();

export function getCubeComponentSelection(cube, create = false) {
	if (!cube || (typeof cube !== 'object' && typeof cube !== 'function')) {
		return {vertices: [], edges: [], faces: []};
	}
	let selection = selections.get(cube);
	if (!selection && create) {
		selection = {vertices: [], edges: [], faces: []};
		selections.set(cube, selection);
	}
	return selection || {vertices: [], edges: [], faces: []};
}

export function setCubeComponentSelection(cube, data) {
	if (!cube || (typeof cube !== 'object' && typeof cube !== 'function')) return;
	const selection = {
		faces: (data?.faces || []).slice(),
		vertices: (data?.vertices || []).slice(),
		edges: (data?.edges || []).map(edge => edge.slice()),
	};
	if (selection.faces.length || selection.vertices.length || selection.edges.length) {
		selections.set(cube, selection);
	} else {
		selections.delete(cube);
	}
}

export function clearCubeComponentSelection(cube) {
	if (cube) selections.delete(cube);
}
