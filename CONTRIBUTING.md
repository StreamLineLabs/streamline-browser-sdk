# Contributing to Streamline Go SDK

Thank you for your interest in contributing to the Streamline Go SDK! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests and linting
5. Commit your changes (`git commit -m "Add my feature"`)
6. Push to your fork (`git push origin feature/my-feature`)
7. Open a Pull Request

## Prerequisites

- Go 1.21 or later

## Development Setup

```bash
# Clone your fork
git clone https://github.com/<your-username>/streamline-go-sdk.git
cd streamline-go-sdk

# Download dependencies
go mod download

# Build
go build ./...

# Run tests
go test ./...
```

## Running Tests

```bash
# Run all tests
go test ./...

# Run with verbose output
go test -v ./...

# Run a specific package's tests
go test -v ./client/...

# Run with race detection
go test -race ./...

# Run with coverage
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

### Integration Tests

Integration tests require a running Streamline server:

```bash
# Start the server
docker compose -f docker-compose.test.yml up -d

# Run integration tests
go test -v -tags=integration ./...

# Stop the server
docker compose -f docker-compose.test.yml down
```

## Linting

```bash
# Format code
go fmt ./...

# Vet code
go vet ./...

# Run staticcheck (if installed)
staticcheck ./...
```

## Code Style

- Follow standard Go conventions and [Effective Go](https://go.dev/doc/effective_go)
- Use `gofmt` for formatting
- Add GoDoc comments for all exported types and functions
- Keep functions focused and short
- Handle errors explicitly — do not ignore them

## Pull Request Guidelines

- Write clear commit messages
- Add tests for new functionality
- Update documentation if needed
- Ensure `go vet ./...` and `go test ./...` pass before submitting

## Reporting Issues

- Use the **Bug Report** or **Feature Request** issue templates
- Search existing issues before creating a new one
- Include reproduction steps for bugs

## Code of Conduct

All contributors are expected to follow our [Code of Conduct](https://github.com/streamlinelabs/.github/blob/main/CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.
