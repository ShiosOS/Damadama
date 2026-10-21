using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Damadama.Migrations
{
    /// <inheritdoc />
    public partial class HabitHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "HabitChanges",
                columns: table => new
                {
                    HabitId = table.Column<Guid>(type: "uuid", nullable: false),
                    Sequence = table.Column<long>(type: "bigint", nullable: false),
                    MutationId = table.Column<Guid>(type: "uuid", nullable: false),
                    Payload = table.Column<string>(type: "text", nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    EffectiveDate = table.Column<DateOnly>(type: "date", nullable: false),
                    CommittedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    AdmissionThrough = table.Column<DateOnly>(type: "date", nullable: true),
                    Name = table.Column<string>(type: "text", nullable: true),
                    Good = table.Column<string>(type: "text", nullable: true),
                    Better = table.Column<string>(type: "text", nullable: true),
                    Best = table.Column<string>(type: "text", nullable: true),
                    Weekdays = table.Column<int[]>(type: "integer[]", nullable: true),
                    RepeatEveryWeeks = table.Column<int>(type: "integer", nullable: true),
                    FirstWeekMonday = table.Column<DateOnly>(type: "date", nullable: true),
                    Choice = table.Column<int>(type: "integer", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HabitChanges", x => new { x.HabitId, x.Sequence });
                    table.CheckConstraint("ChangeAdmission", "(\"AdmissionThrough\" IS NULL AND (\"Kind\" = 0 OR (\"Kind\" = 1 AND \"Weekdays\" IS NULL))) OR (\"AdmissionThrough\" IS NOT NULL AND (\"Kind\" = 2 OR (\"Kind\" = 1 AND \"Weekdays\" IS NOT NULL)))");
                    table.CheckConstraint("ChangeChoice", "\"Choice\" IS NULL OR (\"Choice\" IN (0,1) AND (\"Kind\" = 2 OR (\"Kind\" = 1 AND \"Weekdays\" IS NOT NULL)))");
                    table.CheckConstraint("ChangeDefinitions", "(\"Kind\" IN (0,1) AND num_nonnulls(\"Name\",\"Good\",\"Better\",\"Best\") = 4 AND length(trim(\"Name\")) > 0 AND length(trim(\"Good\")) > 0 AND length(trim(\"Better\")) > 0 AND length(trim(\"Best\")) > 0) OR (\"Kind\" = 2 AND \"Name\" IS NULL AND \"Good\" IS NULL AND \"Better\" IS NULL AND \"Best\" IS NULL)");
                    table.CheckConstraint("ChangeRecurrence", "(\"Weekdays\" IS NULL AND \"RepeatEveryWeeks\" IS NULL AND \"FirstWeekMonday\" IS NULL AND \"Kind\" <> 0) OR (\"Weekdays\" IS NOT NULL AND cardinality(\"Weekdays\") > 0 AND \"Weekdays\" <@ ARRAY[1,2,3,4,5,6,7] AND \"RepeatEveryWeeks\" IS NOT NULL AND \"RepeatEveryWeeks\" > 0 AND \"FirstWeekMonday\" IS NOT NULL AND \"Kind\" <> 2)");
                    table.CheckConstraint("ChangeSequence", "\"Sequence\" >= 0 AND ((\"Kind\" = 0 AND \"Sequence\" = 0) OR (\"Kind\" IN (1,2) AND \"Sequence\" > 0))");
                    table.ForeignKey(
                        name: "FK_HabitChanges_Habits_HabitId",
                        column: x => x.HabitId,
                        principalTable: "Habits",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_HabitChanges_HabitId_MutationId",
                table: "HabitChanges",
                columns: new[] { "HabitId", "MutationId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "HabitChanges");
        }
    }
}
