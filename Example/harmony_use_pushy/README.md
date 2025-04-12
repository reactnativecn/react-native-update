## 运行harmony_use_pushy项目步骤

### 1. 在项目根目录执行下面命令安装第三方依赖。
```
bun install
```

### 2. 本地debug 模式
```
bun run start
```
![image](./debug.png)

### 3. release 模式: 在项目根目录执行下面命令生成bundle包文件。
```
bun run build
```
说明：这个命令会在harmony/entry/src/main/resources/rawfile目录生成Hbundle.harmony.js和assets文件，同时会基于该内容在.pushy/output目录生成ppk包。

**注意⚠️**：在使用pushy bundle --platform harmony命令进行打包的默认bundle包名是Hbundle.harmony.js，不要随意修改包名，因为diff是匹配该包名进行生成的。

### 4. 使用DevEco Studio IDE打开harmony目录然后执行sync运行项目
![image](./sync.png)

### 5 运行效果图
![image](./demo.png)
