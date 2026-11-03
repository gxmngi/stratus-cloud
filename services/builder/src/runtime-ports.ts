import type Docker from 'dockerode';

// Stopped runtimes still own their port: they can be promoted or resumed later.
export async function reservedRuntimePorts(docker: Docker): Promise<Set<number>> {
    const containers = await docker.listContainers({ all: true });
    const runtimes = containers.filter(container => container.Names.some(name => name.startsWith('/stratus-dep-')));
    const inspections = await Promise.all(runtimes.map(container => docker.getContainer(container.Id).inspect()));
    const ports = new Set<number>();
    for (const container of inspections) {
        const portBindings = container.HostConfig.PortBindings as Record<string, { HostPort?: string }[] | undefined> | undefined;
        for (const bindings of Object.values(portBindings || {})) {
            for (const binding of bindings || []) {
                const port = Number(binding.HostPort);
                if (Number.isInteger(port) && port > 0) ports.add(port);
            }
        }
    }
    return ports;
}
