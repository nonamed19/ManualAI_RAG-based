# Dependabot 자동 병합 운영

## 동작

- 기존과 동일하게 메이저·마이너·패치 업데이트 모두 `--auto --squash`로 처리합니다.
- 작성자가 `dependabot[bot]`이고 head/base가 현재 저장소인 열린 일반 PR만 처리합니다.
- PR 생성·재개·커밋 갱신·초안 해제 시 실행하며, 매번 열린 대상 PR 전체를 페이지별로 조회합니다.
- 6시간마다 UTC 00:23 / 06:23 / 12:23 / 18:23 (한국시간 09:23 / 15:23 / 21:23 / 03:23)에 재확인합니다. Actions → Dependabot Auto Merge → Run workflow로도 실행할 수 있습니다.
- 저장소별 실행을 직렬화합니다. 대기 중 실행이 새 실행으로 대체되더라도 다음 전체 조회가 열린 PR을 다시 처리합니다.
- 병합 가능 여부가 계산 중이면 최대 4회 조회합니다. 충돌·계산 대기·병합 도중 head 변경은 다음 실행에서 재시도합니다. 충돌 파일을 자동 수정하지 않습니다.
- `--match-head-commit`으로 조회한 커밋과 병합할 커밋을 일치시킵니다. 이미 자동 병합이 켜졌거나 닫힌 PR은 건너뜁니다.
- 권한·정책·설정 오류는 실패로 남기되 나머지 PR도 처리합니다. 결과는 Actions 실행 요약에 기록합니다.
- Ubuntu 24.04, 10분 제한, job 단위 쓰기 권한을 사용합니다. PR 코드 checkout·설치·실행이나 자동 승인, 규칙 우회는 수행하지 않습니다.

## GitHub 설정

1. Settings → General → Pull Requests에서 **Allow auto-merge**, **Allow squash merging**을 활성화합니다.
2. **2026-11-02 정책 적용 전** Settings → Actions → Policies에서 이 workflow에 적용되는 이벤트 정책에 `pull_request_target`을 명시적으로 허용합니다. actor를 제한한다면 `dependabot[bot]` 및 수동 실행 담당자도 허용합니다. YAML의 `permissions`만으로 이벤트 정책은 변경되지 않습니다. 정기/수동 실행에도 적용되는 상위 정책이 있다면 해당 이벤트도 허용해야 합니다.
3. 테스트 통과 후 병합하려면 별도 읽기 전용 `pull_request` CI를 구성하고, 대상 브랜치의 ruleset/branch protection에서 그 검사를 **필수 상태 검사**로 지정합니다. `--auto`만으로 모든 CI를 기다리지는 않으며, 필수 조건이 없으면 즉시 병합될 수 있습니다. 현재 변경은 애플리케이션 CI나 서버 측 보호 규칙을 추가하지 않습니다.
4. merge queue를 요구하는 경우 기본 `GITHUB_TOKEN`으로 큐 진입이 지원되지 않으므로 공식 안내에 따라 별도 GitHub App 토큰 구성이 필요합니다. 현재 workflow는 기존 토큰을 유지합니다.

정기 실행은 기본 브랜치에 workflow가 반영된 후 동작합니다. GitHub 사정에 따라 지연/누락될 수 있으며 공개 저장소는 60일간 활동이 없으면 정기 실행이 비활성화될 수 있습니다. 즉시 실행 경로를 유지하려면 위 정책 설정이 필요합니다.

## 로컬 검증

저장소 루트에서 Python 표준 라이브러리만으로 실행합니다. 실제 workflow의 인라인 코드를 읽어 GitHub 호출을 모의하므로 실제 PR은 변경하지 않습니다.

```powershell
python -m unittest discover -s .github/tests -v
git diff --check
```

## 조사 근거

- [GitHub 공식 Dependabot 자동화 예제](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions): 기본 토큰 권한, CLI 자동 병합, 필수 상태 검사 설정을 참고했습니다.
- [Microsoft Graph 공개 workflow](https://github.com/microsoftgraph/assign-to-author/blob/main/.github/workflows/auto-merge-dependabot.yml): 봇 대상 자동 병합 사례를 비교했습니다.
- [Dependabot fetch-metadata](https://github.com/dependabot/fetch-metadata): 버전 유형별 필터링 사례를 검토했습니다. 기존 전체 업데이트 자동 병합 범위를 유지하므로 이 의존성과 버전 필터는 추가하지 않았습니다.
- [GitHub CLI merge](https://cli.github.com/manual/gh_pr_merge): `--auto`, `--squash`, `--match-head-commit`을 적용했습니다.
- [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [실행 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [pull_request_target 정책](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)을 참고했습니다.
