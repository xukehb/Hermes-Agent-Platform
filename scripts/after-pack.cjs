const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    console.warn(`[afterPack] 找不到目标应用目录: ${appPath}`);
    return;
  }

  // 检查是否已有合法 Apple 签名，若无则执行 ad-hoc 深度签名
  let needsSigning = false;
  try {
    execSync(`codesign -vvv --strict "${appPath}"`, { stdio: 'pipe' });
  } catch (_e) {
    needsSigning = true;
  }

  if (needsSigning) {
    console.log(`[afterPack] 正在为 macOS 应用进行深度 ad-hoc 签名: ${appPath}`);
    try {
      // 深度签名所有 framework、helper 与主应用二进制，密封资源
      execSync(`codesign --force --deep -s - "${appPath}"`, { stdio: 'inherit' });
      // 清除可能残留的 quarantine 隔离属性
      try {
        execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });
      } catch (_e) {
        // xattr 失败可忽略
      }
      // 再次严格校验签名完整性
      execSync(`codesign -vvv --deep --strict "${appPath}"`, { stdio: 'inherit' });
      console.log(`[afterPack] macOS 应用签名完成并通过严格校验: ${appName}`);
    } catch (error) {
      console.error(`[afterPack] macOS 代码签名失败:`, error);
      throw error;
    }
  } else {
    console.log(`[afterPack] 应用已具备有效签名，跳过 ad-hoc 签名: ${appName}`);
  }
};
