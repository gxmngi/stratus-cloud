import test from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { reservedRuntimePorts } from './runtime-ports';
import { findAvailablePort } from './port-allocator';

test('reserves ports of both running and stopped Stratus runtimes', async () => {
    const inspected: string[] = [];
    const docker = {
        listContainers: async (options: { all: boolean }) => {
            assert.equal(options.all, true);
            return [{ Id: 'active', Names: ['/stratus-dep-active'] },
                { Id: 'sleeping', Names: ['/stratus-dep-sleeping'] }, { Id: 'other', Names: ['/unrelated'] }];
        },
        getContainer: (id: string) => ({ inspect: async () => {
            inspected.push(id);
            return { HostConfig: { PortBindings: { '3000/tcp': [{ HostPort: id === 'active' ? '4101' : '4102' }] } } };
        } }),
    } as unknown as Docker;
    assert.deepEqual(await reservedRuntimePorts(docker), new Set([4101, 4102]));
    assert.deepEqual(inspected.sort(), ['active', 'sleeping']);
});

test('does not allocate a reserved port even when no process is listening', async () => {
    await assert.rejects(findAvailablePort(49150, 49150, new Set([49150])), /No available ports/);
});
