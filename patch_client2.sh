sed -i 's/} = info;/} = updateInfo;/' src/client.ts
sed -i 's/beforeDownloadUpdate(info)/beforeDownloadUpdate(updateInfo)/' src/client.ts
sed -i 's/if (!info.update || !hash) {/if (!updateInfo.update || !hash) {/' src/client.ts
