import net from 'node:net';

export function checkTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);

		socket.once('connect', () => {
			clearTimeout(timer);
			socket.end();
			resolve(true);
		});
		socket.once('error', () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(false);
		});
	});
}
