# DICE ROLL — general version

R777 졸업전시 티저(7면체 주사위)를 다용도 주사위 도구로 일반화한 버전.
원본의 라이팅·카메라·물리 파라미터를 그대로 이식하고, 커스텀 7면체 gltf 대신
TRPG 표준 7종 주사위(d4 d6 d8 d10 d12 d20 d%)를 절차 생성한다.

- 원본(졸전 버전)은 `main` 브랜치에 보존. 이 버전은 `general` 브랜치.
- 라이브(구버전): https://r777-dice-roll.vercel.app/ — 이 repo의 `main`을 그대로 정적 배포한 것.

## 실행

빌드 없음. 정적 서버로 루트를 서빙하면 끝.

```sh
python3 -m http.server 5180
# → http://localhost:5180
```

## 구조

```
index.html            UI 셸 + importmap (제로 빌드, ESM)
src/main.js           씬·물리·투척·정착 감지·HUD — 원본 번들에서 복원한 파라미터 이식
src/dice.js           다면체 절차 생성, 면 숫자 아틀라스, 물리 헐, 값 판정
vendor/               three.js r160 (ESM min) + cannon-es 0.20 — 의존성은 이 둘뿐
```

원본 산출물(bundle.js, ammo wasm, 7면체 glb, R777 그래픽)은 `main` 브랜치에 그대로 있다.

## 원본에서 가져온 것 (bundle.js 역추적)

원본 repo에는 소스가 없고 webpack 번들만 있어, 번들에서 앱 코드(~140줄)를 복원했다.

- 배경 `#00A651`, 바닥 `#019047` (y=-5)
- 카메라: fov 20, (0, 40, 0) → lookAt(0, 0, -5) 탑다운
- 라이트: hemisphere + ambient + directional 각 0.4 (enable3d warpSpeed 기본값), 그림자
- 물리: 중력 -98.1, bounciness 0.6, friction 0.8, 질량 1
- 인터랙션: 클릭한 화면 사분면의 코너에서 5개씩 투척, 필드 최대 300개

## 새로 추가된 것

- 주사위 7종 절차 생성: three.js 기본 다면체 지오메트리에서 동일 평면 삼각형을
  논리 면으로 묶어 추출, d10/d%는 오각 사다리꼴면체 직접 구성 (카이트 평면 h≈0.10557)
- 마주보는 면 합 = n+1 관례로 값 배치, 6/9/60/90 밑줄, d10/d% 숫자는 pole 방향 정렬
- d4는 꼭짓점 숫자(각 면 모서리에 3개) — 위로 솟은 꼭짓점이 값
- 물리: 면별 ConvexPolyhedron 헐 (원본은 7면체조차 box였음)
- 값 판정: 정착(sleep) 시 월드 +Y와 면 법선 내적 최대인 면 (d4는 최상단 꼭짓점),
  기울어진 주사위는 unsure 표시. 판정 타임아웃은 시뮬레이션 시간 기준
- 보이는 화면 영역을 레이캐스트로 계산해 투명 벽 생성 — 주사위가 화면 안에 정착,
  뷰포트 크기 변화에 자동 적응 (모바일 OK)
- HUD: 최근 굴림 내역 + 합계, 필드 개수, 주사위별 머리 위 값 라벨, clear
