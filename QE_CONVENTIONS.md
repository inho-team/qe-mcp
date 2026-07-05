# QE Conventions

## Response Language
- 사용자 입력 언어를 따른다. 사용자가 한국어로 요청하면 결과와 안내도 한국어로 작성한다.

## Repository Boundaries
- `qe-mcp`는 standalone MCP server repository다.
- wrapper workspace 전체 검색은 양쪽 repo가 필요한 경우에만 수행한다.
- 변경은 해당 repo 루트에서 검증한다.

## Planning Flow
```text
Qplan -> Qgs -> Qatomic-run -> Qcode-run-task
```

## Completion Criteria
- 관련 소스 또는 QE 산출물이 생성/수정되어야 한다.
- 변경 범위에 맞는 검증 명령을 실행하거나, 실행하지 못한 이유를 기록한다.
- 기존 사용자 변경사항을 되돌리지 않는다.

## Common Checks
```bash
npm run check
npm run selftest
npm run runner:smoke
```

## Task Status
- `pending`: 아직 시작하지 않음
- `in_progress`: 현재 작업 중
- `blocked`: 외부 입력 또는 환경 조건 필요
- `done`: 구현 및 검증 완료
