const selections = new WeakMap();

export function getCubeComponentSelection(cube, create = false) {
	if (!cube || (typeof cube !== 'object' && typeof cube !== 'function')) {
		return {vertices: [], edges: []};
	}
	let selection = selections.get(cube);
	if (!selection && create) {
		selection = {vertices: [], edges: []};
		selections.set(cube, selection);
	}
	return selection || {vertices: [], edges: []};
}

export function setCubeComponentSelection(cube, data) {
	if (!cube || (typeof cube !== 'object' && typeof cube !== 'function')) return;
	const selection = {
		vertices: (data?.vertices || []).slice(),
		edges: (data?.edges || []).map(edge => edge.slice()),
	};
	if (selection.vertices.length || selection.edges.length) {
		selections.set(cube, selection);
	} else {
		selections.delete(cube);
	}
}

export function clearCubeComponentSelection(cube) {
	if (cube) selections.delete(cube);
}
