import { THREE } from '../lib/libs';

class SceneCursorController {
	constructor() {
		this.position = new THREE.Vector3(0, 0, 0);
		this.object = new THREE.Group();
		this.object.name = 'blockbench_3d_cursor';
		this.object.userData.no_export = true;
		this.object.renderOrder = 10000;
		this.root = null;

		const makeLine = (points, color) => {
			const geometry = new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point)));
			const material = new THREE.LineBasicMaterial({
				color,
				depthTest: false,
				depthWrite: false,
				transparent: true,
				toneMapped: false
			});
			const line = new THREE.Line(geometry, material);
			line.renderOrder = 10000;
			line.userData.no_export = true;
			return line;
		};
		const length = 1.6;
		this.object.add(makeLine([[-length, 0, 0], [length, 0, 0]], 0xff5555));
		this.object.add(makeLine([[0, -length, 0], [0, length, 0]], 0x55dd77));
		this.object.add(makeLine([[0, 0, -length], [0, 0, length]], 0x5599ff));

		const ringMaterial = new THREE.LineBasicMaterial({
			color: 0xffffff,
			depthTest: false,
			depthWrite: false,
			transparent: true,
			opacity: 0.8,
			toneMapped: false
		});
		for (const plane of ['xy', 'yz', 'xz']) {
			const points = [];
			for (let i = 0; i <= 48; i++) {
				const angle = i / 48 * Math.PI * 2;
				const a = Math.cos(angle) * 1.15;
				const b = Math.sin(angle) * 1.15;
				if (plane === 'xy') points.push(new THREE.Vector3(a, b, 0));
				else if (plane === 'yz') points.push(new THREE.Vector3(0, a, b));
				else points.push(new THREE.Vector3(a, 0, b));
			}
			const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), ringMaterial.clone());
			ring.renderOrder = 10000;
			ring.userData.no_export = true;
			this.object.add(ring);
		}
		const center = new THREE.Mesh(
			new THREE.SphereGeometry(0.09, 10, 8),
			new THREE.MeshBasicMaterial({color: 0xffffff, depthTest: false, depthWrite: false, toneMapped: false})
		);
		center.renderOrder = 10001;
		center.userData.no_export = true;
		this.object.add(center);
		this.object.traverse(child => { child.frustumCulled = false; });
	}

	attach(root) {
		if (!root) return;
		if (this.root !== root) {
			this.object.removeFromParent();
			this.root = root;
			root.add(this.object);
		}
		root.updateWorldMatrix(true, false);
		this.object.position.copy(root.worldToLocal(this.position.clone()));
		this.object.updateMatrixWorld(true);
	}

	setPosition(worldPosition) {
		this.position.copy(worldPosition);
		if (this.root) {
			this.root.updateWorldMatrix(true, false);
			this.object.position.copy(this.root.worldToLocal(this.position.clone()));
			this.object.updateMatrixWorld(true);
		}
		return this.position.clone();
	}

	getWorldPosition(target = new THREE.Vector3()) {
		return target.copy(this.position);
	}

	getLocalPosition(parentElement) {
		const position = this.getWorldPosition();
		const parentObject = parentElement?.mesh || this.root;
		if (!parentObject) return position;
		parentObject.updateWorldMatrix(true, false);
		return parentObject.worldToLocal(position);
	}
}

export const SceneCursor = new SceneCursorController();
