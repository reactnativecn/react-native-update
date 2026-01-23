export default {
  // Common messages
  checking_update: '正在检查更新...',
  downloading_update: '正在下载更新包...',
  installing_update: '正在安装更新...',
  update_available: '发现新版本',
  update_downloaded: '更新包下载完成',
  update_installed: '更新安装完成',
  no_update_available: '已是最新版本',
  update_failed: '更新失败',
  network_error: '网络连接错误',
  download_failed: '下载失败',
  install_failed: '安装失败',

  // Progress messages with interpolation
  download_progress: '下载进度: {{progress}}%',
  download_speed: '下载速度: {{speed}}/s',
  file_size: '文件大小: {{size}}',
  time_remaining: '剩余时间: {{time}}',

  // Error messages
  error_code: '错误代码: {{code}}',
  error_message: '错误信息: {{message}}',
  retry_count: '重试次数: {{count}}/{{max}}',

  // Update info
  version_info: '版本 {{version}} ({{build}})',
  release_notes: '更新说明: {{notes}}',
  update_size: '更新包大小: {{size}}MB',

  // Alert messages
  alert_title: '提示',
  alert_update_ready: '下载完毕，是否立即更新?',
  alert_next_time: '下次再说',
  alert_update_now: '立即更新',
  alert_app_updated: '您的应用版本已更新，点击更新下载安装新版本',
  alert_update_button: '更新',
  alert_cancel: '取消',
  alert_confirm: '确定',
  alert_info: '信息',
  alert_no_update_wait: '未发现更新，请等待10秒让服务器生成补丁包',

  // Error messages
  error_appkey_required: '需要提供 appKey',
  error_update_check_failed: '更新检查失败',
  error_cannot_connect_server: '无法连接到更新服务器。请检查网络连接。',
  error_cannot_connect_backup:
    '无法连接到更新服务器: {{message}}。正在尝试备用端点。',
  error_diff_failed: 'diff 错误: {{message}}',
  error_pdiff_failed: 'pdiff 错误: {{message}}',
  error_full_patch_failed: '完整补丁错误: {{message}}',
  error_all_promises_rejected: '所有请求都被拒绝',
  error_ping_failed: 'Ping 失败',
  error_ping_timeout: 'Ping 超时',
  error_http_status: '{{status}} {{statusText}}',

  // Development messages
  dev_debug_disabled:
    '您当前处于开发环境且未启用调试模式。{{matter}} 将不会执行。如需在开发环境中调试 {{matter}}，请在客户端中将 debug 设为 true。',
  dev_log_prefix: 'react-native-update: ',
  dev_web_not_supported:
    'react-native-update 不支持 Web 平台，不会执行任何操作',

  // More alert messages
  alert_new_version_found:
    '检查到新的版本{{name}}，是否下载？\n{{description}}',

  // Development environment messages
  dev_incremental_update_disabled:
    '当前是开发环境，无法执行增量式热更新，重启不会生效。如果需要在开发环境中测试可生效的全量热更新（但也会在再次重启后重新连接 metro），请在网页管理后台的应用设置中打开"忽略时间戳"开关再重试。',

  // Context error messages
  error_use_update_outside_provider:
    'useUpdate 必须在 UpdateProvider 内部使用。请使用 <UpdateProvider client={...}> 包裹您的组件树。',
};
