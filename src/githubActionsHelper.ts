import * as github from '@actions/github'
import * as artifact from '@actions/artifact'
import * as core from '@actions/core'

import * as stateHelper from './stateHelper'
import * as dataProcessingHelper from './dataProcessingHelper'
import * as fs from './fsHelper'
import {ISourceCodeLine} from './types/sourceCodeLine'
import {ITestCase} from './types/testCase'
import {IFileOnDiff} from './types/fileOnDiff'
import {IDiffChangedLines} from './types/diffChangedLines'

export async function createCommitPRCommentLineSuspiciousnessThreshold(
  authToken: string,
  sflRanking: string[],
  sflThreshold: number[],
  sflRankingOrder: string,
  parsedLines: ISourceCodeLine[],
  testCases: ITestCase[],
  diffCommentsInCodeBlock: boolean
) {
  core.debug(`Creating main commit/PR threshold comment...`)
  try {
    let body = ''
    const lines: ISourceCodeLine[] = []
    core.debug(`Filtering lines based on the algorithms threshold...`)
    sflRanking.forEach((algorithm, index) => {
      parsedLines
        .filter(line =>
          line.suspiciousnessMetrics.some(
            suspiciousnessMetric =>
              suspiciousnessMetric.algorithm === algorithm &&
              suspiciousnessMetric.suspiciousnessValue >= sflThreshold[index]
          )
        )
        .forEach(line => {
          if (
            !lines.some(
              l => l.lineNumber === line.lineNumber && l.method === line.method
            )
          ) {
            lines.push(line)
          }
        })
    })

    core.debug(
      `Sorting lines based on the ranking algorithm to order table results...`
    )
    lines.sort((a, b) => {
      const aSuspiciousnessValue = a.suspiciousnessMetrics.find(
        obj => obj.algorithm === sflRankingOrder
      )?.suspiciousnessValue

      const bSuspiciousnessValue = b.suspiciousnessMetrics.find(
        obj => obj.algorithm === sflRankingOrder
      )?.suspiciousnessValue

      if (
        aSuspiciousnessValue === undefined ||
        bSuspiciousnessValue === undefined
      ) {
        return 0
      }

      return bSuspiciousnessValue - aSuspiciousnessValue
    })

    // Create comment on commit/PR
    if (lines.length === 0) {
      if (!testCases.some(testCase => testCase.passed === false)) {
        body +=
          '✅ **As there is no failing test, GZoltar has nothing to report** 🙌'
      } else {
        body += '**Based on the action inputs, GZoltar has nothing to report**'
      }
    } else {
      body += '⚠️ **GZoltar fault localization report** ⚠️'

      core.debug(`Processing Line Suspiciousness by Algorithm...`)
      body +=
        '<details>\n<summary>Line Suspiciousness by Algorithm</summary>\n\n'
      body += dataProcessingHelper.getStringTableLineSuspiciousness(
        lines,
        sflRanking,
        sflRankingOrder,
        testCases
      )
      body += '</details>\n'

      core.debug(`Processing Lines Code Block Suspiciousness by Algorithm...`)
      body +=
        '<details>\n<summary>Lines Code Block Suspiciousness by Algorithm</summary>\n\n'
      body +=
        dataProcessingHelper.getStringTableLineSuspiciousnessWithCodeBlockWithNormalLines(
          lines,
          sflRanking,
          sflRankingOrder
        )
      body += '</details>\n'
    }

    body += '\n\n'

    await createCommitPRComment(authToken, {body})

    core.info(`Creating commit/PR threshold diff comment...`)
    // Create comment on diff of commit
    core.debug(`Getting files shown in the diff...`)
    const filesOnDiff: IFileOnDiff[] = await getFilesOnDiff(authToken)

    if (diffCommentsInCodeBlock) {
      core.debug(
        `Getting lines shown in the diff and create diff comments Code Block Suspiciousness by Algorithm...`
      )
      filesOnDiff.forEach(file => {
        const linesShownOnDiffFile = lines.filter(
          line =>
            '/' + file.path === line.method.file.path &&
            file.changedLines.some(
              changed =>
                changed.startLine <= line.lineNumber &&
                changed.endLine >= line.lineNumber
            )
        )

        // group lines that are next to each other
        let linesNextToEachOther =
          dataProcessingHelper.groupLinesNextToEachOther(linesShownOnDiffFile)

        // sort grouped lines by max suspiciousness based on sflRankingOrder
        linesNextToEachOther =
          dataProcessingHelper.sortedGroupedLinesBySflRankingOrder(
            linesNextToEachOther,
            sflRankingOrder
          )

        linesNextToEachOther.forEach(groupOfLines => {
          void createCommitPRComment(
            authToken,
            {
              body:
                '<details><summary>Lines Code Block Suspiciousness by Algorithm</summary>\n\n## Lines Code Block Suspiciousness by Algorithm\n' +
                dataProcessingHelper.getStringTableLineSuspiciousnessWithCodeBlockWithLinesNextToEachOther(
                  groupOfLines,
                  sflRanking,
                  true
                ) +
                '</details>',
              path: file.path,
              position: getLinePosition(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                file.changedLines.find(
                  changed =>
                    changed.startLine <= groupOfLines[0].lineNumber &&
                    changed.endLine >= groupOfLines[0].lineNumber
                )!,
                Math.max(...groupOfLines.map(line => line.lineNumber))
              )
            },
            true
          )
        })
      })
    } else {
      core.debug(
        `Getting lines shown in the diff and create diff comments Line Suspiciousness by Algorithm...`
      )
      lines.forEach(line => {
        const fileOnDiff = filesOnDiff.find(
          file => '/' + file.path === line.method.file.path
        )

        if (fileOnDiff) {
          const changedLinesAffected: IDiffChangedLines | undefined =
            fileOnDiff.changedLines.find(
              changed =>
                changed.startLine <= line.lineNumber &&
                changed.endLine >= line.lineNumber
            )

          if (changedLinesAffected) {
            void createCommitPRComment(
              authToken,
              {
                body:
                  '<details><summary>Line Suspiciousness by Algorithm</summary>\n\n## Line Suspiciousness by Algorithm\n' +
                  dataProcessingHelper.getStringTableLineSuspiciousnessForSingleLine(
                    line,
                    sflRanking,
                    testCases,
                    true
                  ) +
                  '</details>',
                path: fileOnDiff.path,
                position: getLinePosition(changedLinesAffected, line.lineNumber)
              },
              true
            )
          }
        }
      })
    }
  } catch (error) {
    throw new Error(
      `Encountered an error when creating Commit/PR comment based on threshold of algorithms: ${
        // eslint-disable-next-line
        (error as any)?.message ?? error
      }`
    )
  }
}

function getLinePosition(
  changedLinesAffected: IDiffChangedLines,
  lineNumber: number
): number {
  const numberOfDoublePosition =
    changedLinesAffected.linesRemovedNotConsidered.filter(
      line => line <= lineNumber
    ).length

  return (
    lineNumber -
    changedLinesAffected.startLine +
    changedLinesAffected.startDiffPosition +
    numberOfDoublePosition
  )
}

async function createCommitPRComment(
  authToken: string,
  inputs: {body: string; path?: string; position?: number},
  forceCommentOnCommit?: boolean
) {
  try {
    const octokit = getOctokit(authToken)
    forceCommentOnCommit = forceCommentOnCommit || false
    if (stateHelper.isInPullRequest && !forceCommentOnCommit) {
      // Issues and PRs are the same for the GitHub API
      await octokit.rest.issues.createComment({
        owner: stateHelper.repoOwner,
        repo: stateHelper.repoName,
        issue_number: stateHelper.pullRequestNumber,
        body: inputs.body
      })
    } else {
      await octokit.rest.repos.createCommitComment({
        owner: stateHelper.repoOwner,
        repo: stateHelper.repoName,
        commit_sha: stateHelper.currentCommitSha,
        body: inputs.body,
        path: inputs.path,
        position: inputs.position
      })
    }
  } catch (error) {
    throw new Error(
      `Encountered an error when creating Commit/PR comment: ${
        // eslint-disable-next-line
        (error as any)?.message ?? error
      }`
    )
  }
}

async function getFilesOnDiff(authToken: string): Promise<IFileOnDiff[]> {
  try {
    if (stateHelper.baseCommitSha === undefined) {
      core.error(
        `The base commit sha is undefined. This is needed to get the diff between the base and head commits for this event.`
      )
      return []
    }

    const octokit = getOctokit(authToken)

    const response = await octokit.rest.repos.compareCommits({
      owner: stateHelper.repoOwner,
      repo: stateHelper.repoName,
      base: stateHelper.baseCommitSha,
      head: stateHelper.currentCommitSha
    })

    // Making sure the API call was successful
    if (response.status !== 200) {
      throw new Error(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `The request needed to get the diff between the base and head commits for this event returned ${response.status} when it is expected 200.`
      )
    }

    const statusConsidered = [
      'added',
      'modified',
      'renamed',
      'copied',
      'changed',
      'unchanged'
    ]

    const files =
      response.data.files?.filter(file => {
        return statusConsidered.includes(file.status)
      }) ?? []

    const filesOnDiff: IFileOnDiff[] = []

    files.forEach(file => {
      const changedLines: IDiffChangedLines[] = []
      if (file.patch) {
        const patchLines = file.patch.split('\n')
        let lastDiffPosition = 0
        let currentSection: IDiffChangedLines | null = null

        patchLines.forEach(line => {
          if (line.startsWith('@@')) {
            if (currentSection) {
              changedLines.push(currentSection)
            }
            const lineSplitted = line.split(' ')
            const lineSplitted2 = lineSplitted[2].split(',')
            const startLine = parseInt(lineSplitted2[0].substring(1))
            const sizeOfCodeBlock = parseInt(lineSplitted2[1])
            const endLine = startLine + sizeOfCodeBlock - 1

            currentSection = {
              startLine: startLine,
              endLine: endLine,
              startDiffPosition: lastDiffPosition + 1,
              linesRemovedNotConsidered: []
            }
          } else {
            lastDiffPosition++

            if (line.startsWith('-') && currentSection) {
              currentSection.linesRemovedNotConsidered.push(
                lastDiffPosition -
                  currentSection.startDiffPosition +
                  currentSection.startLine
              )
            }
          }
        })

        if (currentSection) {
          changedLines.push(currentSection)
        }
      }

      filesOnDiff.push({path: file.filename, changedLines: changedLines})
    })

    return filesOnDiff
  } catch (error) {
    throw new Error(
      `Encountered an error when getting diff: ${
        // eslint-disable-next-line
        (error as any)?.message ?? error
      }`
    )
  }
}

function getOctokit(authToken: string) {
  return github.getOctokit(authToken)
}

export async function uploadArtifacts(
  artifactName: string,
  filesPaths: string[],
  directoriesPaths: string[]
) {
  try {
    const artifactClient = artifact.create()

    const rootDirectory = stateHelper.rootDirectory

    const options: artifact.UploadOptions = {
      continueOnError: true
    }

    directoriesPaths.forEach(directoryPath => {
      filesPaths = [...filesPaths, ...fs.getFilesFromDirectory(directoryPath)]
    })

    const uploadResult: artifact.UploadResponse =
      await artifactClient.uploadArtifact(
        artifactName,
        filesPaths,
        rootDirectory,
        options
      )

    if (uploadResult.failedItems.length > 0) {
      core.error(
        `Failed to upload some artifacts: ${uploadResult.failedItems.toString()}`
      )
    }
  } catch (error) {
    throw new Error(
      `Encountered an error when uploading artifacts: ${
        // eslint-disable-next-line
        (error as any)?.message ?? error
      }`
    )
  }
}
