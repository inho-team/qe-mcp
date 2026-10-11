pipeline {
    agent none

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        skipDefaultCheckout(true)
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    stages {
        stage('Linux') {
            agent { label 'docker' }
            steps {
                checkout scm
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    withEnv(["PATH+NODE20=/home/jenkins/agent/tools/node20/node-v20.20.2-linux-x64/bin"]) {
                        sh 'node --version && npm run check && npm run selftest'
                    }
                }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    sh 'node --version && npm run check && npm run selftest'
                }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
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

        stage('Windows') {
            agent { label 'windows' }
            steps {
                bat 'git config --global core.autocrlf false'
                checkout scm
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    withEnv(["PATH+NODE20=C:/Users/kjsun/AppData/Local/JenkinsAgent/node20/node-v20.20.2-win-x64"]) {
                        bat 'node --version && call npm.cmd run check && call npm.cmd run selftest'
                    }
                }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    withEnv(["PATH+NODE22=C:/Users/kjsun/AppData/Local/JenkinsAgent/node22/node-v22.23.2-win-x64"]) {
                        bat 'node --version && call npm.cmd run check && call npm.cmd run selftest'
                    }
                }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }
    }
}
