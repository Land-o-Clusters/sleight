export function stateSetupRequest(task, marker, container) {
  if (!container || container.local !== true || typeof container.id !== 'string' || !container.id || !task.scripting) {
    throw new Error('an explicitly local fixture container is required');
  }
  return { bundle: task.bundle, marker, containerID: container.id, descriptor: task.scripting };
}
