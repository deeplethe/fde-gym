# 자료의 출처와 승인 범위

2026-11-05 사용자가 디자인 스킬과 기능에 대해 검토와 컴플라이언스 승인을 받았으며 개인 GitHub에 올려 집 PC에서 활용해도 된다고 확인했다. 이후 집 PC 원격 조작은 필요 없고, 현재 PC의 디자인 관련 정보를 집 Claude Code가 받아 동일한 수준의 디자인을 만드는 것이 성공 기준이라고 정정했다.

이 저장소에는 당시 `design-studio` 스킬과 `design-library` 자료를 담는다. 시작 틀과 기준 시안은 회사 업무 과정에서 만든 자료이며 이 출처를 숨기지 않는다. 회사 원본 서비스 저장소, 운영 데이터베이스, 자격증명과 다른 업무 문서를 일괄 가져오는 승인은 아니다.

`payload-manifest.json`은 각 원본의 상대 경로, 배포 경로, 바이트 수와 SHA-256을 기록한다. 자동 지시로 실행되지 않도록 공개 참고 자료의 SKILL.md 같은 파일 이름에 `.vendor.txt`를 붙였으며 본문은 보존한다. Git 메타데이터, 캐시, 로컬 환경 파일은 포함하지 않는다. 제외한 개별 자료는 manifest에 기록한다.

| 범위 | 출처와 용도 |
| --- | --- |
| 활성 스킬과 도구 | 기존 design-studio에서 이식. 홈 경로, 브라우저 경로, 설치와 업데이트 방식을 독립 실행에 맞게 수정 |
| 원본 스킬 | `original-skill/`에 보존. 과거 경로와 승인 이전 문구는 역사 기록이며 현재 실행 지시가 아님 |
| 기준 시안과 평가 | 당시 design-library의 스냅샷. 예시 데이터를 쓴 디자인 자료이며 운영 성과 증거가 아님 |
| KP 자료와 서체 | 승인 범위의 기존 참고 자료. 새 개인 화면 기본 서체는 Pretendard와 Archivo |
| 공개 스킬 | `library/MANIFEST.json`의 원본 저장소와 커밋. 각 저장소의 라이선스 유지 |
| 라이브러리 | `library/libs/LIBS.json`의 배포 버전. 배포 파일의 라이선스 유지 |

전체 묶음을 새 MIT 코드라고 선언하지 않는다. 공개 자료 중 별도 사용 조건이 있는 코드와 서체는 각 원본 조건을 따른다. 승인된 비공개 개인 활용과 공개 재배포는 같은 권한이 아니다. 설치 과정은 참고 자료에 든 프로그램을 자동 실행하지 않는다.

공식 설치 위치 근거는 [Claude Code 문서](https://code.claude.com/docs/en/skills#choose-where-skills-load)와 [OpenAI CLI 문서의 에이전트 설치 표](https://developers.openai.com/api/reference/cli#use-the-cli-from-a-coding-agent)다. 확인일은 2026-11-05다.
