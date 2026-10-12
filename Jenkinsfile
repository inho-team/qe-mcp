pipeline {
    agent none

    options {
        timeout(time: 90, unit: 'MINUTES')
        disableConcurrentBuilds()
        skipDefaultCheckout(true)
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    stages {
        stage('Linux') {
            agent { label 'macmini' }
            environment {
                PATH = "/opt/homebrew/bin:${env.PATH}"
                DOCKER_HOST = 'unix:///Users/kimjinseong/.colima/ci/docker.sock'
            }
            steps {
                checkout scm
                sh 'colima start --profile ci --activate=false'
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    sh '''docker run --rm -e HOME=/tmp -v "$WORKSPACE:/workspace" -w /workspace node:20.20.2-bookworm-slim sh -lc 'node --version && npm run check && npm run selftest' '''
                }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    sh '''docker run --rm -e HOME=/tmp -v "$WORKSPACE:/workspace" -w /workspace node:22.23.2-bookworm-slim sh -lc 'node --version && npm run check && npm run selftest' '''
                }
            }
            post {
                always {
                    sh '''
                        if docker info >/dev/null 2>&1; then
                            running=$(docker ps -q)
                            if [ -z "$running" ]; then
                                colima stop --profile ci
                            else
                                echo "CI Docker has running containers; inspect them before stopping the profile."
                            fi
                        fi
                    '''
                    cleanWs(deleteDirs: true, notFailBuild: true)
                }
            }
        }

        stage('macOS') {
            agent { label 'macmini' }
            steps {
                checkout scm
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    withEnv(["PATH+NODE20=/Users/kimjinseong/.nvm/versions/node/v20.20.2/bin"]) {
                        sh 'node --version && npm run check && npm run selftest'
                    }
                }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    withEnv(["PATH+NODE22=/Users/kimjinseong/.nvm/versions/node/v22.23.2/bin"]) {
                        sh 'node --version && npm run check && npm run selftest'
                    }
                }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }
    }
}
