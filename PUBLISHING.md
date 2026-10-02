# 배포 가이드 (Marketplace / Open VSX)

이 문서는 Twinlock을 직접 배포할 때 필요한 절차입니다. 아래 순서대로 진행하면 됩니다. 배포 전 점검은 `npm run check:release`가 자동으로 해 줍니다.

## 0. 준비물

- Node.js 18 이상, Git
- GitHub 계정: README 이미지가 GitHub 저장소에서 서비스됩니다.
- Visual Studio Marketplace 퍼블리셔: <https://marketplace.visualstudio.com/manage> 에서 Microsoft 계정으로 만듭니다.
- 퍼블리시 토큰(PAT): Azure DevOps(<https://dev.azure.com>) → User settings → Personal access tokens → **New Token**
  - Organization: **All accessible organizations**
  - Scopes: **Custom defined → Marketplace → Manage**

## 1. GitHub 저장소 만들고 올리기

README의 스크린샷과 아이콘은 `https://github.com/<user>/<repo>/raw/HEAD/...` 주소로 표시됩니다. 그래서 **배포 전에 코드를 GitHub에 push해 두어야 마켓플레이스 페이지의 이미지가 깨지지 않습니다.**

```bash
git add -A
git commit -m "Twinlock 1.0.0"
git branch -M main
git remote add origin https://github.com/<user>/twinlock.git
git push -u origin main
```

## 2. 퍼블리셔와 저장소 주소 설정

```bash
npm run configure -- --publisher <퍼블리셔ID> --repo https://github.com/<user>/twinlock
```

이 명령은 `package.json`의 `publisher`, `repository`, `bugs`, `homepage`를 한 번에 바꿉니다. 바뀐 내용은 커밋하고 push해 주세요.

> 마켓플레이스 확장 ID는 `<퍼블리셔ID>.twinlock`이 됩니다. 표시 이름(`displayName`)이 이미 쓰이고 있으면 배포가 거부되는데, 2026-10 기준으로 "Twinlock"은 사용되지 않고 있습니다.

## 3. 검사, 테스트, 패키징

```bash
npm ci                    # 의존성 설치
npm run test:unit         # 단위 테스트
npm run test:integration  # 실제 VS Code를 내려받아 통합 테스트 (선택, 수 분 소요)
npm run package           # 배포 점검 + twinlock-1.0.0.vsix 생성
```

`npm run package`는 먼저 `check:release`를 실행해, 다음 문제가 하나라도 있으면 패키징을 멈춥니다.

- 퍼블리셔나 저장소 주소가 아직 placeholder로 남아 있음
- CHANGELOG에 현재 버전 섹션이 없음
- 아이콘이 PNG가 아니거나 128×128보다 작음
- README의 이미지나 링크 대상 파일이 없음, 또는 SVG 이미지나 http 링크가 있음
- `@types/vscode` 버전이 `engines.vscode`보다 높음
- package.json에 선언된 명령이 코드에 등록되어 있지 않음

생성된 VSIX는 직접 설치해서 확인할 수 있습니다.

```bash
code --install-extension twinlock-1.0.0.vsix
```

## 4. 배포

**방법 A: 명령줄**

```bash
npx vsce login <퍼블리셔ID>      # 1회. PAT를 붙여 넣습니다.
npm run publish:marketplace     # 배포 점검 후 vsce publish
```

**방법 B: 웹 업로드.** <https://marketplace.visualstudio.com/manage> → 퍼블리셔 → **New extension → Visual Studio Code** → `twinlock-1.0.0.vsix`를 업로드합니다.

배포 후 몇 분 안에 `https://marketplace.visualstudio.com/items?itemName=<퍼블리셔ID>.twinlock`에 페이지가 나타납니다.

## 5. (선택) Open VSX: VSCodium, Cursor 등

```bash
npx ovsx create-namespace <퍼블리셔ID> -p <OpenVSX 토큰>
npx ovsx publish twinlock-1.0.0.vsix -p <OpenVSX 토큰>
```

토큰은 <https://open-vsx.org> 에 로그인한 뒤 Settings → Access Tokens에서 만듭니다.

## 6. 다음 버전 배포

1. `CHANGELOG.md` 맨 위에 `## [x.y.z] - 날짜` 섹션을 추가합니다.
2. `npm version patch` (또는 `minor` / `major`)로 버전을 올립니다.
3. `npm run publish:marketplace`를 실행합니다.

## 참고: 스크린샷 다시 찍기

UI가 바뀌면 다음 명령으로 README 스크린샷을 다시 만들 수 있습니다. 실제 VS Code를 DevTools 프로토콜로 조작해 찍기 때문에, 화면이 잠겨 있어도 동작합니다.

```bash
npm run build
node scripts/screenshots/capture.mjs     # media/screenshots/*.png 갱신
```

먼저 `npm run test:integration`을 한 번 실행해 `.vscode-test/`에 VS Code를 받아 두거나, VS Code 실행 파일 경로를 인자로 넘기면 됩니다.

## 참고: 라이선스 표기

`LICENSE`의 저작권자는 `Twinlock contributors`로 되어 있습니다. 필요하면 본인 이름으로 바꾸세요.
