module.exports = {
	apps: [
		{
			name: 'cscommends',
			script: './service.js',
			cwd: __dirname,
			exec_mode: 'fork',
			instances: 1,
			max_memory_restart: '2G',
			autorestart: true,
			watch: false,
			min_uptime: '60s',
			max_restarts: 10,
			restart_delay: 5000,

			out_file: './logs/pm2-out.log',
			error_file: './logs/pm2-err.log',
			merge_logs: true,
			log_date_format: 'YYYY-MM-DD HH:mm:ss',

			env: {
				NODE_ENV: 'production'
			},

			exponential_backoff_restart_delay: 5000
		}
	]
};
